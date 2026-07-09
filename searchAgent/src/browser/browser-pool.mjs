const IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

export class BrowserPool {
    constructor({
        poolSize,
        executablePath,
        headlessMode = 'new',
        proxyUrl = '',
        userDataDir = '',
        acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
        log = console,
    }) {
        this.poolSize = poolSize;
        this.executablePath = executablePath;
        this.headlessMode = headlessMode;
        this.proxyUrl = proxyUrl || '';
        this.userDataDir = userDataDir || '';
        this.acquireTimeoutMs = acquireTimeoutMs;
        this.log = log;

        this.puppeteer = null;
        this.slots = [];
        this.waitQueue = [];
        this.idleTimer = null;
        this.closed = false;
        this.uaIndex = 0;
    }

    async warmUp() {
        const module = await import('puppeteer-core');
        this.puppeteer = module.default || module;

        for (let i = 0; i < this.poolSize; i += 1) {
            const browser = await this.launchBrowser();
            this.slots.push({ browser, busy: false, lastUsed: Date.now() });
        }

        this.startIdleTimer();
        this.log.info?.('browser pool warmed up', { size: this.poolSize });
    }

    async acquire(signal) {
        if (this.closed) throw new Error('Browser pool is closed.');
        if (signal?.aborted) throw signal.reason || new Error('Aborted.');

        const available = this.slots.find((slot) => !slot.busy && slot.browser?.isConnected());
        if (available) return this.checkout(available, signal);

        const crashed = this.slots.find((slot) => !slot.busy && !slot.browser?.isConnected());
        if (crashed) {
            crashed.browser = await this.launchBrowser();
            return this.checkout(crashed, signal);
        }

        return this.enqueue(signal);
    }

    async release(handle) {
        if (!handle?._slot || handle._released) return;
        handle._released = true;
        const slot = handle._slot;

        if (handle._signal && handle._abortListener) {
            handle._signal.removeEventListener('abort', handle._abortListener);
        }

        if (handle._context) {
            await handle._context.close().catch(() => {});
        }

        slot.busy = false;
        slot.lastUsed = Date.now();
        this.drainNext(slot);
    }

    status() {
        const available = this.slots.filter((slot) => !slot.busy && slot.browser?.isConnected()).length;
        const busy = this.slots.filter((slot) => slot.busy).length;
        return {
            total: this.poolSize,
            available,
            busy,
            queued: this.waitQueue.length,
        };
    }

    async closeAll() {
        this.closed = true;
        if (this.idleTimer) clearInterval(this.idleTimer);

        for (const waiter of this.waitQueue) {
            waiter.reject(new Error('Browser pool shutting down.'));
        }
        this.waitQueue.length = 0;

        const shutdowns = this.slots.map(async (slot) => {
            if (!slot.browser) return;
            const pid = slot.browser.process?.()?.pid;
            try {
                await Promise.race([
                    slot.browser.close(),
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('close timeout')), SHUTDOWN_GRACE_MS);
                    }),
                ]);
            } catch {
                if (pid) {
                    try {
                        process.kill(pid, 'SIGKILL');
                    } catch {
                        // The browser already exited.
                    }
                }
            }
        });

        await Promise.allSettled(shutdowns);
        this.slots.length = 0;
    }

    async launchBrowser() {
        const args = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
        ];
        if (this.proxyUrl) {
            args.push(`--proxy-server=${this.proxyUrl}`);
        }

        const launchOptions = {
            executablePath: this.executablePath,
            headless: this.headlessMode === 'new' ? 'new' : true,
            args,
        };
        if (this.userDataDir) {
            launchOptions.userDataDir = this.userDataDir;
        }

        return this.puppeteer.launch(launchOptions);
    }

    async checkout(slot, signal) {
        if (signal?.aborted) throw signal.reason || new Error('Aborted.');

        if (!slot.browser?.isConnected()) {
            slot.browser = await this.launchBrowser();
        }

        slot.busy = true;
        let context = null;
        let abortListener = null;

        try {
            const userAgent = USER_AGENTS[this.uaIndex % USER_AGENTS.length];
            this.uaIndex += 1;

            context = await slot.browser.createBrowserContext();
            const page = await context.newPage();
            await page.setUserAgent(userAgent);
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            if (signal) {
                abortListener = () => {
                    context.close().catch(() => {});
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }

            return {
                page,
                browser: slot.browser,
                _slot: slot,
                _context: context,
                _signal: signal || null,
                _abortListener: abortListener,
                _released: false,
            };
        } catch (error) {
            if (signal && abortListener) {
                signal.removeEventListener('abort', abortListener);
            }
            if (context) {
                await context.close().catch(() => {});
            }
            slot.busy = false;
            slot.lastUsed = Date.now();
            this.drainNext(slot);
            throw error;
        }
    }

    enqueue(signal) {
        if (signal?.aborted) {
            return Promise.reject(signal.reason || new Error('Aborted.'));
        }

        return new Promise((resolve, reject) => {
            let timer = null;
            let abortListener = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
            };
            const entry = {
                signal,
                resolve(value) {
                    cleanup();
                    resolve(value);
                },
                reject(error) {
                    cleanup();
                    reject(error);
                },
            };

            this.waitQueue.push(entry);
            timer = setTimeout(() => {
                const index = this.waitQueue.indexOf(entry);
                if (index !== -1) this.waitQueue.splice(index, 1);
                entry.reject(new Error('Browser pool acquire timeout.'));
            }, this.acquireTimeoutMs);

            if (signal) {
                abortListener = () => {
                    const index = this.waitQueue.indexOf(entry);
                    if (index !== -1) this.waitQueue.splice(index, 1);
                    entry.reject(signal.reason || new Error('Aborted.'));
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }
        });
    }

    drainNext(slot) {
        if (this.closed || slot.busy) return;
        const waiter = this.waitQueue.shift();
        if (!waiter) return;
        this.checkout(slot, waiter.signal)
            .then(waiter.resolve)
            .catch(waiter.reject);
    }

    startIdleTimer() {
        this.idleTimer = setInterval(() => {
            const now = Date.now();
            for (const slot of this.slots) {
                if (!slot.busy && slot.browser?.isConnected() && now - slot.lastUsed > IDLE_TIMEOUT_MS) {
                    slot.browser.close().catch(() => {});
                    slot.browser = null;
                    this.log.info?.('browser pool idle slot closed');
                }
            }
        }, 60_000);

        if (this.idleTimer.unref) this.idleTimer.unref();
    }
}

import { spawn } from 'node:child_process';
import process from 'node:process';

const files = [
    new URL('./test/normalize.test.mjs', import.meta.url).pathname,
    new URL('./test/server.test.mjs', import.meta.url).pathname,
    new URL('./test/settings.test.mjs', import.meta.url).pathname,
];

const child = spawn(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exitCode = code || 0;
});

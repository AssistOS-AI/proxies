import { resolveSettings } from '../lib/constants.mjs';
import { listModelRows } from '../lib/allow-list.mjs';
import { readState } from '../lib/service-state.mjs';

// A failing models handler makes Soul Gateway create a placeholder `default`
// model, so every path ends with a valid list and exit code 0.
function drainStdin() {
    return new Promise((resolve) => {
        process.stdin.on('data', () => {});
        process.stdin.on('end', resolve);
        process.stdin.on('error', resolve);
    });
}

async function main() {
    let data = [];
    try {
        await drainStdin();
        const { stateFile } = resolveSettings(process.env);
        data = listModelRows(readState(stateFile));
    } catch (error) {
        process.stderr.write(`[opencode-free] model listing failed: ${error?.code || error?.name || 'error'}\n`);
        data = [];
    }
    process.stdout.write(JSON.stringify({ object: 'list', data }));
    process.exitCode = 0;
}

main().catch(() => {
    process.stdout.write(JSON.stringify({ object: 'list', data: [] }));
    process.exitCode = 0;
});

import { acquireSlot, releaseSlot } from '../../lib/slots.mjs';
import { applyTransition } from '../../lib/service-state.mjs';

let slot = null;

process.on('message', async (message) => {
    try {
        if (message.op === 'acquire') {
            slot = await acquireSlot(message.options);
            process.send({ op: 'acquired', index: slot ? slot.index : null, dir: slot ? slot.dir : null });
        } else if (message.op === 'release') {
            releaseSlot(slot);
            slot = null;
            process.send({ op: 'released' });
        } else if (message.op === 'transition') {
            const result = applyTransition(message.file, message.name, message.patch || {}, { role: message.role });
            process.send({ op: 'transitioned', applied: result.applied, state: result.state.state });
        } else if (message.op === 'exit') {
            process.exit(0);
        }
    } catch (error) {
        process.send({ op: 'error', message: String(error?.message || error) });
    }
});

process.send({ op: 'ready' });

const API_KEY = process.env.SOUL_GATEWAY_API_KEY;
if (!API_KEY) {
    console.error('Set SOUL_GATEWAY_API_KEY');
    process.exit(1);
}

const response = await fetch('https://soul.axiologic.dev/v1/models', {
    method: 'GET',
    headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
    },
});

if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
}

const { data } = await response.json();

// Soul Gateway mixes `type: 'model'` (concrete) and `type: 'tier'`
// (virtual alias fanning out to a list of concrete models). Split them.
const models = data.filter((m) => m.type !== 'tier');

for (const m of models) console.log(`  ${m.id.padEnd(40)}  ${m.owned_by}`);

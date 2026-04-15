#!/usr/bin/env node
// Test all models in the search tier via soul.axiologic.dev
// Usage: node test-search-tier.mjs [query]

const SOUL_URL = process.env.SOUL_GATEWAY_URL || 'https://soul.axiologic.dev';
const SOUL_KEY = process.env.SOUL_GATEWAY_API_KEY;

if (!SOUL_KEY) {
    console.error(
        'ERROR: SOUL_GATEWAY_API_KEY not set. Source ~/work/.env or run via test-search-tier.sh'
    );
    process.exit(1);
}
const QUERY = process.argv[2] || 'What is Node.js';

async function main() {
    console.log('============================================');
    console.log('  Search Tier Test — soul.axiologic.dev');
    console.log(`  Query: "${QUERY}"`);
    console.log('============================================\n');

    // Fetch search tier models
    const tiersResp = await fetch(`${SOUL_URL}/v1/tiers`);
    const tiersData = await tiersResp.json();
    const searchTier = tiersData.data?.find((t) => t.name === 'search');

    if (!searchTier || !searchTier.models?.length) {
        console.log('ERROR: No search tier or no models found');
        process.exit(1);
    }

    console.log('Models in search tier:');
    for (const m of searchTier.models) console.log(`  - ${m}`);
    console.log('\n--------------------------------------------');

    let pass = 0,
        fail = 0;

    for (let i = 0; i < searchTier.models.length; i++) {
        const model = searchTier.models[i];
        console.log(`\n[${i + 1}/${searchTier.models.length}] ${model}`);

        const start = Date.now();
        try {
            const resp = await fetch(`${SOUL_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${SOUL_KEY}`,
                    'Content-Type': 'application/json',
                    'X-Soul-Agent': 'search-tier-test',
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: QUERY }],
                }),
                signal: AbortSignal.timeout(30000),
            });

            const latency = Date.now() - start;
            const data = await resp.json();

            if (!resp.ok) {
                const msg = data.error?.message || JSON.stringify(data);
                console.log(`  FAIL  ${resp.status} ${latency}ms — ${msg}`);
                fail++;
                continue;
            }

            const content = data.choices?.[0]?.message?.content || '';
            const lines = content.split('\n').filter((l) => l.trim());
            const noResults = content.includes('No results found');

            if (noResults) {
                console.log(`  WARN  ${latency}ms — no results returned`);
                fail++;
            } else if (lines.length > 0) {
                console.log(`  PASS  ${latency}ms — ${lines.length} lines`);
                // Show first 3 lines
                for (const line of lines.slice(0, 3)) {
                    console.log(`    ${line.slice(0, 120)}`);
                }
                if (lines.length > 3) console.log('    ...');
                pass++;
            } else {
                console.log(`  WARN  ${latency}ms — empty response`);
                fail++;
            }
        } catch (err) {
            const latency = Date.now() - start;
            console.log(`  FAIL  ${latency}ms — ${err.message}`);
            fail++;
        }
    }

    console.log('\n============================================');
    console.log(
        `  Results: ${pass} passed, ${fail} failed (${searchTier.models.length} total)`
    );
    console.log('============================================');
    process.exit(fail > 0 ? 1 : 0);
}

main();

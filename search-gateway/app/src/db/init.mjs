import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.mjs';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('db');
const __dirname = dirname(fileURLToPath(import.meta.url));

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ max: 10 });
    pool.on('error', (err) => log.error('Pool error', { error: err.message }));
  }
  return pool;
}

export async function query(text, params) {
  const client = await getPool().connect();
  try {
    await client.query(`SET search_path TO ${config.pgSchema}, public`);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function initDb() {
  const p = getPool();

  // Create schema
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${config.pgSchema}`);

  // Run schema DDL
  const schemaPath = join(__dirname, 'schema.sql');
  const ddl = readFileSync(schemaPath, 'utf8');
  await p.query(ddl);

  // Create monthly partitions (current month + next 3 months)
  await ensurePartitions();

  // Seed providers from environment variables
  await seedProviders();

  log.info('Database initialization complete');
}

async function ensurePartitions() {
  const now = new Date();
  for (let i = -1; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const next = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
    const name = `search_logs_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
    const from = d.toISOString().slice(0, 10);
    const to = next.toISOString().slice(0, 10);
    try {
      await query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF search_logs
         FOR VALUES FROM ('${from}') TO ('${to}')`
      );
    } catch (err) {
      if (!err.message.includes('already exists') && !err.message.includes('overlap')) {
        log.warn(`Partition ${name} creation issue`, { error: err.message });
      }
    }
  }

  // Drop partitions older than retention period
  const cutoff = new Date(now.getFullYear(), now.getMonth() - Math.ceil(config.retentionDays / 30), 1);
  try {
    const { rows } = await query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = $1 AND tablename LIKE 'search_logs_%'
    `, [config.pgSchema]);

    for (const { tablename } of rows) {
      const match = tablename.match(/search_logs_(\d{4})_(\d{2})/);
      if (match) {
        const partDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, 1);
        if (partDate < cutoff) {
          await query(`DROP TABLE IF EXISTS ${tablename}`);
          log.info(`Dropped old partition: ${tablename}`);
        }
      }
    }
  } catch (err) {
    log.warn('Partition cleanup issue', { error: err.message });
  }
}

const SEED_PROVIDERS = [
  { name: 'tavily',     display_name: 'Tavily',     provider_type: 'tavily',     envVar: 'TAVILY_API_KEY',  monthly_quota: 1000, sort_order: 10 },
  { name: 'brave',      display_name: 'Brave Search', provider_type: 'brave',    envVar: 'BRAVE_API_KEY',   monthly_quota: 1000, sort_order: 20 },
  { name: 'exa',        display_name: 'Exa',        provider_type: 'exa',        envVar: 'EXA_API_KEY',     monthly_quota: 1000, sort_order: 30 },
  { name: 'jina',       display_name: 'Jina AI',    provider_type: 'jina',       envVar: 'JINA_API_KEY',    monthly_quota: null, sort_order: 40 },
  { name: 'serper',     display_name: 'Serper',      provider_type: 'serper',    envVar: 'SERPER_API_KEY',  monthly_quota: 2500, sort_order: 50 },
  { name: 'duckduckgo', display_name: 'DuckDuckGo',  provider_type: 'duckduckgo', envVar: null,            monthly_quota: null, sort_order: 60 },
  { name: 'searxng',    display_name: 'SearXNG',     provider_type: 'searxng',   envVar: 'SEARXNG_URL',     monthly_quota: null, sort_order: 70 },
];

async function seedProviders() {
  const { encrypt } = await import('../utils/crypto.mjs');

  for (const prov of SEED_PROVIDERS) {
    // Check if provider already exists
    const { rows } = await query('SELECT id FROM search_providers WHERE name = $1', [prov.name]);
    if (rows.length > 0) continue;

    const envValue = prov.envVar ? process.env[prov.envVar] : null;

    // Skip providers without API keys (except keyless ones like duckduckgo/searxng)
    if (prov.envVar && !envValue) continue;

    // For SearXNG, envValue is a URL, not an API key
    let encApiKey = null;
    let keyHint = null;
    let baseUrl = null;

    if (prov.provider_type === 'searxng') {
      baseUrl = envValue;
    } else if (prov.provider_type === 'duckduckgo') {
      // No key needed
    } else if (envValue) {
      encApiKey = encrypt(envValue);
      keyHint = envValue.length > 12
        ? envValue.slice(0, 8) + '...' + envValue.slice(-4)
        : envValue.slice(0, 4) + '...';
    }

    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
    nextMonth.setUTCHours(0, 0, 0, 0);

    await query(`
      INSERT INTO search_providers (name, display_name, provider_type, base_url, encrypted_api_key, key_hint, monthly_quota, quota_reset_at, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (name) DO NOTHING
    `, [prov.name, prov.display_name, prov.provider_type, baseUrl, encApiKey, keyHint, prov.monthly_quota, nextMonth, prov.sort_order]);

    // Create corresponding search model
    const providerRow = await query('SELECT id FROM search_providers WHERE name = $1', [prov.name]);
    if (providerRow.rows.length > 0) {
      const modelName = `${prov.name}-search`;
      await query(`
        INSERT INTO search_models (name, display_name, provider_id, model_type, sort_order)
        VALUES ($1, $2, $3, 'search', $4)
        ON CONFLICT (name) DO NOTHING
      `, [modelName, `${prov.display_name} Search`, providerRow.rows[0].id, prov.sort_order]);
    }

    log.info(`Seeded provider: ${prov.name}`);
  }

  // Seed deep-research model if soul-gateway is configured
  if (config.soulGatewayApiKey) {
    await query(`
      INSERT INTO search_models (name, display_name, model_type, config, sort_order)
      VALUES ('deep-research', 'Deep Research', 'research', $1, 200)
      ON CONFLICT (name) DO NOTHING
    `, [JSON.stringify({
      llm_url: config.soulGatewayUrl,
      llm_api_key_env: 'SOUL_GATEWAY_API_KEY',
      llm_model: 'fast',
      max_sub_queries: 5,
      providers_per_query: 2,
      max_total_results: 30,
    })]);
  }
}

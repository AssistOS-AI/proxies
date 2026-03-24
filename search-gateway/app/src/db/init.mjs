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

async function seedProviders() {
  // Only seed DuckDuckGo (keyless, always available).
  // All other providers are managed via the dashboard.
  const { rows } = await query('SELECT id FROM search_providers WHERE name = $1', ['duckduckgo']);
  if (rows.length === 0) {
    await query(`
      INSERT INTO search_providers (name, display_name, provider_type, monthly_quota, sort_order)
      VALUES ('duckduckgo', 'DuckDuckGo', 'duckduckgo', NULL, 60)
      ON CONFLICT (name) DO NOTHING
    `);
    const providerRow = await query('SELECT id FROM search_providers WHERE name = $1', ['duckduckgo']);
    if (providerRow.rows.length > 0) {
      await query(`
        INSERT INTO search_models (name, display_name, provider_id, model_type, sort_order)
        VALUES ('duckduckgo-search', 'DuckDuckGo Search', $1, 'search', 60)
        ON CONFLICT (name) DO NOTHING
      `, [providerRow.rows[0].id]);
    }
    log.info('Seeded provider: duckduckgo');
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

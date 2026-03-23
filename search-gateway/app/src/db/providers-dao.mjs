import { query } from './init.mjs';
import { encrypt, decrypt } from '../utils/crypto.mjs';

const SAFE_COLUMNS = 'id, name, display_name, provider_type, base_url, key_hint, config, monthly_quota, monthly_usage, quota_reset_at, is_enabled, sort_order, created_at';

export async function listProviders(enabledOnly = false) {
  const where = enabledOnly ? 'WHERE is_enabled = true' : '';
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM search_providers ${where} ORDER BY sort_order ASC, name ASC`);
  return rows;
}

export async function getProviderById(id) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM search_providers WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getProviderByName(name) {
  const { rows } = await query(`SELECT ${SAFE_COLUMNS} FROM search_providers WHERE name = $1`, [name]);
  return rows[0] || null;
}

export async function getProviderApiKey(id) {
  const { rows } = await query('SELECT encrypted_api_key FROM search_providers WHERE id = $1', [id]);
  if (!rows[0]?.encrypted_api_key) return null;
  return decrypt(rows[0].encrypted_api_key);
}

export async function createProvider({ name, display_name, provider_type, base_url, api_key, config, monthly_quota }) {
  let encKey = null;
  let keyHint = null;
  if (api_key) {
    encKey = encrypt(api_key);
    keyHint = api_key.length > 12
      ? api_key.slice(0, 8) + '...' + api_key.slice(-4)
      : api_key.slice(0, 4) + '...';
  }

  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);

  const { rows } = await query(`
    INSERT INTO search_providers (name, display_name, provider_type, base_url, encrypted_api_key, key_hint, config, monthly_quota, quota_reset_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING ${SAFE_COLUMNS}
  `, [name, display_name || name, provider_type, base_url, encKey, keyHint, config || {}, monthly_quota, nextMonth]);
  return rows[0];
}

export async function updateProvider(id, fields) {
  const allowed = ['name', 'display_name', 'base_url', 'config', 'monthly_quota', 'is_enabled', 'sort_order'];
  const sets = [];
  const params = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && allowed.includes(key)) {
      sets.push(`${key} = $${idx}`);
      params.push(key === 'config' ? JSON.stringify(value) : value);
      idx++;
    }
  }

  if (fields.api_key && typeof fields.api_key === 'string' && fields.api_key.length > 0) {
    const encKey = encrypt(fields.api_key);
    const keyHint = fields.api_key.length > 12
      ? fields.api_key.slice(0, 8) + '...' + fields.api_key.slice(-4)
      : fields.api_key.slice(0, 4) + '...';
    sets.push(`encrypted_api_key = $${idx}`);
    params.push(encKey);
    idx++;
    sets.push(`key_hint = $${idx}`);
    params.push(keyHint);
    idx++;
  }

  if (sets.length === 0) return null;
  params.push(id);

  const { rows } = await query(
    `UPDATE search_providers SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${SAFE_COLUMNS}`,
    params
  );
  return rows[0] || null;
}

export async function deleteProvider(id) {
  const { rows } = await query('DELETE FROM search_providers WHERE id = $1 RETURNING id, name', [id]);
  return rows[0] || null;
}

export async function incrementUsage(id) {
  // Reset usage if past quota_reset_at
  await query(`
    UPDATE search_providers
    SET monthly_usage = CASE
      WHEN quota_reset_at IS NOT NULL AND quota_reset_at < now()
      THEN 1
      ELSE monthly_usage + 1
    END,
    quota_reset_at = CASE
      WHEN quota_reset_at IS NOT NULL AND quota_reset_at < now()
      THEN (date_trunc('month', now()) + interval '1 month')
      ELSE quota_reset_at
    END
    WHERE id = $1
  `, [id]);
}

export async function checkQuota(provider) {
  if (!provider.monthly_quota) return true; // No quota limit
  // Reset if past reset date
  if (provider.quota_reset_at && new Date(provider.quota_reset_at) < new Date()) {
    return true; // Will be reset on next increment
  }
  return provider.monthly_usage < provider.monthly_quota;
}

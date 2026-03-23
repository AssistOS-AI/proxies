import { query } from './init.mjs';

export async function listModels(enabledOnly = false) {
  const where = enabledOnly ? 'WHERE m.is_enabled = true' : '';
  const { rows } = await query(`
    SELECT m.*, p.name as provider_name, p.display_name as provider_display_name
    FROM search_models m
    LEFT JOIN search_providers p ON m.provider_id = p.id
    ${where}
    ORDER BY m.sort_order ASC, m.name ASC
  `);
  return rows;
}

export async function getModelByName(name) {
  const { rows } = await query('SELECT * FROM search_models WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function createModel({ name, display_name, provider_id, model_type, config, sort_order }) {
  const { rows } = await query(`
    INSERT INTO search_models (name, display_name, provider_id, model_type, config, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [name, display_name || name, provider_id || null, model_type || 'search', config || {}, sort_order || 100]);
  return rows[0];
}

export async function updateModel(id, fields) {
  const allowed = ['name', 'display_name', 'provider_id', 'model_type', 'config', 'is_enabled', 'sort_order'];
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
  if (sets.length === 0) return null;
  params.push(id);

  const { rows } = await query(
    `UPDATE search_models SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  return rows[0] || null;
}

export async function toggleModel(id) {
  const { rows } = await query(
    'UPDATE search_models SET is_enabled = NOT is_enabled WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

export async function deleteModel(id) {
  const { rows } = await query('DELETE FROM search_models WHERE id = $1 RETURNING id, name', [id]);
  return rows[0] || null;
}

export async function deleteByProviderId(providerId) {
  const { rowCount } = await query('DELETE FROM search_models WHERE provider_id = $1', [providerId]);
  return rowCount;
}

import { query } from '../db/init.mjs';
import { decrypt } from '../utils/crypto.mjs';
import { ModelNotFoundError } from '../utils/errors.mjs';

/**
 * Resolve a model name to its provider config.
 * Returns: { model, provider, providerType, apiKey, baseUrl, providerConfig, modelConfig }
 */
export async function resolveSearchModel(modelName) {
  // Look up model
  const { rows: modelRows } = await query(
    'SELECT * FROM search_models WHERE name = $1', [modelName]
  );
  const model = modelRows[0];
  if (!model) throw new ModelNotFoundError(modelName);
  if (!model.is_enabled) throw new ModelNotFoundError(`${modelName} (disabled)`);

  // deep-research has no provider_id
  if (model.model_type === 'research') {
    return {
      model,
      provider: null,
      providerType: 'research',
      apiKey: null,
      baseUrl: null,
      providerConfig: {},
      modelConfig: model.config || {},
    };
  }

  // Look up provider
  if (!model.provider_id) throw new ModelNotFoundError(`${modelName} (no provider configured)`);

  const { rows: provRows } = await query(
    'SELECT * FROM search_providers WHERE id = $1', [model.provider_id]
  );
  const provider = provRows[0];
  if (!provider) throw new ModelNotFoundError(`${modelName} (provider not found)`);
  if (!provider.is_enabled) throw new ModelNotFoundError(`${modelName} (provider disabled)`);

  // Decrypt API key if present
  let apiKey = null;
  if (provider.encrypted_api_key) {
    apiKey = decrypt(provider.encrypted_api_key);
  }

  return {
    model,
    provider,
    providerType: provider.provider_type,
    apiKey,
    baseUrl: provider.base_url,
    providerConfig: provider.config || {},
    modelConfig: model.config || {},
  };
}

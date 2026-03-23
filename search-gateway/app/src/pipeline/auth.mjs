import { resolveApiKey } from '../db/keys-dao.mjs';
import { AuthError } from '../utils/errors.mjs';

export async function authenticate(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header');
  }
  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) throw new AuthError('Empty API key');

  const keyInfo = await resolveApiKey(rawKey);
  if (!keyInfo) {
    throw new AuthError('Invalid, expired, or revoked API key');
  }

  return {
    api_key_id: keyInfo.id,
    rpm_limit: keyInfo.rpm_limit,
  };
}

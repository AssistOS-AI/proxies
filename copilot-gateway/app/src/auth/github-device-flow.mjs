import { createLogger } from '../utils/logger.mjs';
import { config } from '../config.mjs';

const log = createLogger('device-flow');

export async function getDeviceCode() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({ client_id: config.clientId, scope: 'read:user' }),
  });
  return res.json();
}

export async function pollAccessToken(deviceCode) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let interval = (deviceCode.interval + 1) * 1000;
  const expiresAt = Date.now() + (deviceCode.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(interval);
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        device_code: deviceCode.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      return data.access_token;
    }
    if (data.error === 'slow_down') {
      interval += 5000;
      log.debug('GitHub requested slow down, increasing interval', { interval });
    }
    log.debug('Waiting for device flow authorization', { error: data.error });
  }
  throw new Error('Device flow timed out — user did not authorize in time');
}

export async function runDeviceFlow() {
  const deviceCode = await getDeviceCode();
  log.info(`GitHub device flow: go to ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`);
  const accessToken = await pollAccessToken(deviceCode);
  return accessToken;
}

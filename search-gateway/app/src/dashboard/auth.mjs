import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readBody, sendJson, sendError } from '../utils/http-helpers.mjs';
import { config } from '../config.mjs';

const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds
const sessions = new Map();

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

export function handleLogin(req, res) {
  if (req.method === 'GET') {
    // Serve simple login form
    const html = `<!DOCTYPE html>
<html><head><title>Search Gateway Login</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1d232a}
form{background:#2a323c;padding:2rem;border-radius:8px;color:#a6adba}
input{display:block;width:250px;padding:8px;margin:8px 0;border-radius:4px;border:1px solid #3d4451;background:#1d232a;color:#fff}
button{width:100%;padding:8px;background:#661ae6;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:8px}</style></head>
<body><form method="POST" action="/login"><h2>Search Gateway</h2>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Login</button></form></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'POST') {
    return (async () => {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const password = params.get('password') || '';

      if (!config.dashboardPassword) {
        // No password configured — allow access
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now());
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `session=${token}; Path=/; HttpOnly; Max-Age=${SESSION_MAX_AGE}`,
        });
        return res.end();
      }

      const expected = hashPassword(config.dashboardPassword);
      const actual = hashPassword(password);
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(actual, 'hex');

      if (timingSafeEqual(expectedBuf, actualBuf)) {
        const token = randomBytes(32).toString('hex');
        sessions.set(token, Date.now());
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `session=${token}; Path=/; HttpOnly; Max-Age=${SESSION_MAX_AGE}`,
        });
        return res.end();
      }

      res.writeHead(302, { Location: '/login?error=1' });
      res.end();
    })();
  }
}

export function handleLogout(req, res) {
  const cookie = parseCookie(req.headers.cookie || '');
  if (cookie.session) sessions.delete(cookie.session);
  res.writeHead(302, {
    Location: '/login',
    'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
  });
  res.end();
}

export function checkSession(req) {
  if (!config.dashboardPassword) return true;
  const cookie = parseCookie(req.headers.cookie || '');
  if (!cookie.session) return false;
  const ts = sessions.get(cookie.session);
  if (!ts) return false;
  if (Date.now() - ts > SESSION_MAX_AGE * 1000) {
    sessions.delete(cookie.session);
    return false;
  }
  return true;
}

function parseCookie(str) {
  const obj = {};
  for (const pair of str.split(';')) {
    const [k, v] = pair.trim().split('=');
    if (k) obj[k] = v || '';
  }
  return obj;
}

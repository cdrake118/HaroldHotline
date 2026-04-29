const crypto = require('crypto');

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { cookies[k] = decodeURIComponent(v); } catch (_) { cookies[k] = v; }
  });
  return cookies;
}

function makeToken(password) {
  const secret = process.env.ADMIN_SESSION_SECRET || password;
  return crypto.createHmac('sha256', secret).update(password).digest('hex');
}

function checkCookie(req) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return true;
  const token = parseCookies(req).harold_auth;
  if (!token) return false;
  const expected = makeToken(password);
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

function checkBasicAuth(req) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return true;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return pass === password;
  } catch (_) { return false; }
}

// Protects API routes — returns 401 JSON if not authenticated
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return next();
  if (checkBasicAuth(req) || checkCookie(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Harold Admin"');
  res.status(401).json({ error: 'Authentication required' });
}

// Protects page routes — redirects to /login if not authenticated
function pageAuth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return next();
  if (checkBasicAuth(req) || checkCookie(req)) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

module.exports = { makeToken, adminAuth, pageAuth };

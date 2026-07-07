const crypto = require('crypto');

const DEFAULT_AUTH_SECRET = 'tecnoland-dev-secret';
const isProduction = process.env.NODE_ENV === 'production';
const configuredAuthSecret = process.env.TECNOLAND_AUTH_SECRET || process.env.AUTH_SECRET || '';
const SESSION_COOKIE_NAME = 'tecnoland_session';

function getAuthSecret() {
  if (configuredAuthSecret) return configuredAuthSecret;
  if (isProduction) {
    throw new Error('Falta TECNOLAND_AUTH_SECRET o AUTH_SECRET para firmar sesiones en producción.');
  }
  return DEFAULT_AUTH_SECRET;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signSession(payload) {
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', getAuthSecret()).update(body).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${body}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', getAuthSecret()).update(body).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const { hash: candidate } = createPasswordHash(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function parseCookies(request) {
  const header = request?.headers?.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const separator = part.indexOf('=');
        if (separator < 0) return [part, ''];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function tokenFromRequest(request) {
  const cookies = parseCookies(request);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = request?.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function sessionFromRequest(request) {
  return verifySession(tokenFromRequest(request));
}

function sessionCookie(token, maxAgeSeconds = 60 * 60 * 12) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isProduction ? '; Secure' : ''}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? '; Secure' : ''}`;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { signSession, verifySession, createPasswordHash, verifyPassword, slugify, isProduction, parseCookies, tokenFromRequest, sessionFromRequest, sessionCookie, clearSessionCookie, SESSION_COOKIE_NAME };

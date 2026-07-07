const { pool, ensureDatabase } = require('../lib/database');
const { signSession, verifyPassword, sessionFromRequest, sessionCookie, clearSessionCookie } = require('../lib/security');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const loginAttempts = new Map();

function clientAddress(request) {
  const forwarded = request.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return request.socket?.remoteAddress || 'unknown';
}

function loginKey(request, username) {
  return `${clientAddress(request)}::${String(username).trim().toLowerCase()}`;
}

function readLoginState(key) {
  const state = loginAttempts.get(key);
  if (!state) return null;
  if (state.lockedUntil && state.lockedUntil > Date.now()) return state;
  if (Date.now() - state.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return state;
}

function registerFailedAttempt(key) {
  const now = Date.now();
  const previous = readLoginState(key);
  const state = previous ? { ...previous } : { count: 0, firstAttemptAt: now, lockedUntil: 0 };
  if (now - state.firstAttemptAt > LOGIN_WINDOW_MS) {
    state.count = 0;
    state.firstAttemptAt = now;
    state.lockedUntil = 0;
  }
  state.count += 1;
  if (state.count >= MAX_LOGIN_ATTEMPTS) state.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, state);
  return state;
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    if (request.method === 'GET' && request.query.route === 'session') {
      const session = sessionFromRequest(request);
      if (!session) return response.status(401).json({ error: 'Acceso no autorizado.' });
      return response.status(200).json({ user: { id: Number(session.sub), fullName: session.name, username: session.username, role: session.role } });
    }
    if (request.method === 'POST' && request.query.route === 'login') {
      const { username = '', password = '' } = request.body || {};
      const key = loginKey(request, username);
      const state = readLoginState(key);
      if (state?.lockedUntil && state.lockedUntil > Date.now()) {
        response.setHeader('Retry-After', String(Math.ceil((state.lockedUntil - Date.now()) / 1000)));
        return response.status(429).json({ error: 'Demasiados intentos fallidos. Intenta nuevamente en unos minutos.' });
      }
      const { rows: [user] } = await pool.query(
        'select * from users where lower(username)=lower($1) and active=true limit 1',
        [String(username).trim()]
      );
      if (!user) {
        registerFailedAttempt(key);
        return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      const valid = verifyPassword(String(password), user.password_salt, user.password_hash);
      if (!valid) {
        registerFailedAttempt(key);
        return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      }
      clearLoginAttempts(key);
      const token = signSession({ sub: String(user.id), username: user.username, role: user.role, name: user.full_name, exp: Date.now() + 1000 * 60 * 60 * 12 });
      response.setHeader('Set-Cookie', sessionCookie(token));
      return response.status(200).json({ user: { id: Number(user.id), fullName: user.full_name, username: user.username, role: user.role } });
    }
    if (request.method === 'POST' && request.query.route === 'logout') {
      response.setHeader('Set-Cookie', clearSessionCookie());
      return response.status(200).json({ ok: true });
    }
    return response.status(404).json({ error: 'Ruta no encontrada.' });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: 'No fue posible autenticar.' });
  }
};

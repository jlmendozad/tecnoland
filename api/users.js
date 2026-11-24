const { pool, ensureDatabase } = require('../lib/database');
const { createPasswordHash, verifyPassword, sessionFromRequest } = require('../lib/security');
const { recordHistory } = require('../lib/history');

const MIN_PASSWORD_LENGTH = 8;
const passwordProblem = value => String(value || '').length < MIN_PASSWORD_LENGTH ? `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` : null;

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    const session = sessionFromRequest(request);
    if (!session) return response.status(401).json({ error: 'Acceso no autorizado.' });

    if (request.method === 'PATCH' && request.query.route === 'me-password') {
      const { id, currentPassword = '', newPassword = '' } = request.body || {};
      if (!id || String(session.sub) !== String(id)) return response.status(403).json({ error: 'Solo puedes cambiar tu propia contraseña.' });
      if (!String(newPassword).trim()) return response.status(400).json({ error: 'La nueva contraseña es obligatoria.' });
      if (passwordProblem(newPassword)) return response.status(400).json({ error: passwordProblem(newPassword) });
      const { rows: [user] } = await pool.query('select * from users where id=$1 and active=true', [id]);
      if (!user) return response.status(404).json({ error: 'Usuario no encontrado.' });
      const valid = verifyPassword(String(currentPassword), user.password_salt, user.password_hash);
      if (!valid) return response.status(400).json({ error: 'La contraseña actual no coincide.' });
      const { salt, hash } = createPasswordHash(String(newPassword));
      await pool.query('update users set password_salt=$2, password_hash=$3, updated_at=now() where id=$1', [id, salt, hash]);
      return response.status(200).json({ ok: true });
    }

    if (session.role !== 'admin') return response.status(401).json({ error: 'Acceso no autorizado.' });

    // Un administrador asigna una contraseña temporal a otro usuario que la olvidó.
    if (request.method === 'PATCH' && request.query.route === 'reset-password') {
      const { id, newPassword = '' } = request.body || {};
      if (passwordProblem(newPassword)) return response.status(400).json({ error: passwordProblem(newPassword) });
      const { salt, hash } = createPasswordHash(String(newPassword));
      const { rows: [user] } = await pool.query(
        'update users set password_salt=$2, password_hash=$3, updated_at=now() where id=$1 returning id, full_name, username',
        [id, salt, hash]
      );
      if (!user) return response.status(404).json({ error: 'Usuario no encontrado.' });
      await recordHistory(pool, { action: 'password_reset', session, details: { userId: Number(user.id), username: user.username, fullName: user.full_name } });
      return response.status(200).json({ ok: true });
    }

    if (request.method === 'GET') {
      const { rows } = await pool.query('select id, full_name, username, role, active, created_at from users order by created_at desc, id desc');
      return response.status(200).json(rows.map(user => ({ id: Number(user.id), fullName: user.full_name, username: user.username, role: user.role, active: user.active, createdAt: user.created_at })));
    }

    if (request.method === 'POST') {
      const { fullName = '', username = '', password = '', role = 'socio' } = request.body || {};
      if (!String(fullName).trim() || !String(username).trim() || !String(password).trim()) return response.status(400).json({ error: 'Nombre, usuario y contraseña son obligatorios.' });
      if (passwordProblem(password)) return response.status(400).json({ error: passwordProblem(password) });
      const { salt, hash } = createPasswordHash(String(password));
      const { rows: [user] } = await pool.query(
        `insert into users (full_name, username, role, password_salt, password_hash)
         values ($1,$2,$3,$4,$5)
         returning id, full_name, username, role, active, created_at`,
        [String(fullName).trim(), String(username).trim(), role === 'admin' ? 'admin' : 'socio', salt, hash]
      );
      return response.status(201).json({ id: Number(user.id), fullName: user.full_name, username: user.username, role: user.role, active: user.active, createdAt: user.created_at });
    }

    if (request.method === 'PATCH') {
      const { id, active, role } = request.body || {};
      const normalizedRole = role === 'admin' ? 'admin' : role === 'socio' ? 'socio' : null;
      if (normalizedRole && String(session.sub) === String(id) && normalizedRole !== 'admin') {
        return response.status(400).json({ error: 'No puedes quitarte tu propio rol de administrador.' });
      }
      const { rows: [user] } = await pool.query(
        `update users
         set active=coalesce($2, active),
             role=coalesce($3, role),
             updated_at=now()
         where id=$1
         returning id, full_name, username, role, active, created_at`,
        [id, typeof active === 'boolean' ? active : null, normalizedRole]
      );
      if (!user) return response.status(404).json({ error: 'Usuario no encontrado.' });
      return response.status(200).json({ id: Number(user.id), fullName: user.full_name, username: user.username, role: user.role, active: user.active, createdAt: user.created_at });
    }

    return response.status(405).json({ error: 'Método no permitido.' });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: 'No fue posible procesar la solicitud.' });
  }
};

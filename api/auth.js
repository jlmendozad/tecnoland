const { pool, ensureDatabase } = require('../lib/database');
const { signSession, verifyPassword } = require('../lib/security');

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    if (request.method === 'POST' && request.query.route === 'login') {
      const { username = '', password = '' } = request.body || {};
      const { rows: [user] } = await pool.query(
        'select * from users where lower(username)=lower($1) and active=true limit 1',
        [String(username).trim()]
      );
      if (!user) return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      const valid = verifyPassword(String(password), user.password_salt, user.password_hash);
      if (!valid) return response.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      const token = signSession({ sub: String(user.id), username: user.username, role: user.role, name: user.full_name, exp: Date.now() + 1000 * 60 * 60 * 12 });
      return response.status(200).json({ token, user: { id: Number(user.id), fullName: user.full_name, username: user.username, role: user.role } });
    }
    return response.status(404).json({ error: 'Ruta no encontrada.' });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: 'No fue posible autenticar.' });
  }
};

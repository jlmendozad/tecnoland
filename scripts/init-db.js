const { ensureDatabase, pool } = require('../lib/database');

ensureDatabase()
  .then(() => console.log('Supabase inicializado para Tecnoland.'))
  .finally(() => pool.end());

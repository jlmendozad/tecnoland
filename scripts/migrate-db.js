// Copia todos los datos de Tecnoland de una base Postgres a otra (por ejemplo, de Supabase a Neon).
//
// Uso:
//   SOURCE_DATABASE_URL="postgres://...supabase..." \
//   TARGET_DATABASE_URL="postgres://...neon..." \
//   npm run db:migrate
//
// - Crea las tablas en la base destino (sin productos de ejemplo ni usuario inicial).
// - Se niega a continuar si la base destino ya tiene productos, usuarios o pedidos,
//   a menos que se pase --replace (borra los datos del destino antes de copiar).
// - Todo ocurre dentro de una transacción: si algo falla, el destino queda como estaba.
// - La base origen solo se lee; nunca se modifica.

const { Client } = require('pg');
const { applySchema } = require('../lib/schema');

// Orden respetando llaves foráneas.
const TABLES = ['users', 'products', 'product_images', 'inventory_history', 'orders', 'order_items', 'site_settings'];
const IDENTITY_TABLES = ['users', 'products', 'product_images', 'inventory_history', 'orders', 'order_items'];
const BATCH_SIZE = 200;

function clientFor(url, label) {
  if (!url) throw new Error(`Falta ${label}.`);
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('channel_binding');
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  return new Client({
    connectionString: parsed.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    // Fechas y JSON se copian como texto para no perder precisión (microsegundos).
    types: { getTypeParser: () => value => value }
  });
}

function describe(url) {
  const { hostname } = new URL(url);
  return hostname;
}

async function count(client, table) {
  const { rows: [{ total }] } = await client.query(`select count(*)::int as total from ${table}`);
  return Number(total);
}

async function columnsOf(client, table) {
  const { rows } = await client.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [table]
  );
  return rows.map(row => row.column_name);
}

async function tableExists(client, table) {
  const { rows: [row] } = await client.query(`select to_regclass($1) as name`, [`public.${table}`]);
  return Boolean(row.name);
}

async function copyTable(source, target, table) {
  if (!(await tableExists(source, table))) {
    console.log(`  ${table}: no existe en el origen, se omite`);
    return 0;
  }
  const sourceColumns = await columnsOf(source, table);
  const targetColumns = new Set(await columnsOf(target, table));
  const columns = sourceColumns.filter(column => targetColumns.has(column));
  const skipped = sourceColumns.filter(column => !targetColumns.has(column));
  if (skipped.length) console.log(`  ${table}: columnas sin equivalente en el destino (se omiten): ${skipped.join(', ')}`);

  const list = columns.map(column => `"${column}"`).join(', ');
  const { rows } = await source.query(`select ${list} from ${table} order by 1`);
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = [];
    const tuples = batch.map(row => {
      const placeholders = columns.map(column => {
        values.push(row[column]);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await target.query(`insert into ${table} (${list}) overriding system value values ${tuples.join(', ')}`, values);
  }
  return rows.length;
}

async function main() {
  const replace = process.argv.includes('--replace');
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  const source = clientFor(sourceUrl, 'SOURCE_DATABASE_URL');
  const target = clientFor(targetUrl, 'TARGET_DATABASE_URL');
  if (describe(sourceUrl) === describe(targetUrl) && new URL(sourceUrl).pathname === new URL(targetUrl).pathname) {
    throw new Error('El origen y el destino apuntan a la misma base.');
  }

  console.log(`Origen:  ${describe(sourceUrl)}`);
  console.log(`Destino: ${describe(targetUrl)}`);
  await source.connect();
  await target.connect();

  try {
    // Lectura consistente del origen.
    await source.query('begin isolation level repeatable read read only');
    await target.query('begin');
    await applySchema(target);

    const existing = {};
    for (const table of ['users', 'products', 'orders']) existing[table] = await count(target, table);
    const hasData = Object.values(existing).some(total => total > 0);
    if (hasData && !replace) {
      throw new Error(
        `La base destino ya tiene datos (usuarios: ${existing.users}, productos: ${existing.products}, pedidos: ${existing.orders}). ` +
        'Usa --replace si quieres borrarlos y reemplazarlos con los del origen.'
      );
    }
    await target.query(`truncate ${TABLES.join(', ')} restart identity cascade`);

    console.log('Copiando:');
    const copied = {};
    for (const table of TABLES) {
      copied[table] = await copyTable(source, target, table);
      console.log(`  ${table}: ${copied[table]} filas`);
    }

    for (const table of IDENTITY_TABLES) {
      await target.query(
        `select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}), 0) + 1, false)`
      );
    }

    console.log('Verificando conteos:');
    for (const table of TABLES) {
      const expected = (await tableExists(source, table)) ? await count(source, table) : 0;
      const actual = await count(target, table);
      if (expected !== actual) throw new Error(`${table}: origen tiene ${expected} filas y destino ${actual}.`);
      console.log(`  ${table}: ${actual} ✓`);
    }

    await target.query('commit');
    await source.query('commit');
    console.log('Migración completa. La base origen no fue modificada.');
  } catch (error) {
    await target.query('rollback').catch(() => {});
    await source.query('rollback').catch(() => {});
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

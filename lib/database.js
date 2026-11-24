const { Pool } = require('pg');
const seedProducts = require('../data/seed-products.json');
const { createPasswordHash, slugify, isProduction } = require('./security');
const { applySchema, defaultStorefrontSettings } = require('./schema');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
if (!connectionString) throw new Error('Falta DATABASE_URL o POSTGRES_URL para conectar con la base de datos.');
const databaseUrl = new URL(connectionString);
databaseUrl.searchParams.delete('sslmode');

const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000
});

// Prepara las tablas una sola vez por instancia del servidor, no en cada solicitud.
let databaseReady = null;
function ensureDatabase() {
  if (!databaseReady) databaseReady = prepareDatabase().catch(error => { databaseReady = null; throw error; });
  return databaseReady;
}

async function prepareDatabase() {
  await applySchema(pool);

  const { rows: [{ count }] } = await pool.query('select count(*)::int as count from products');
  if (count === 0) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const product of seedProducts) {
        const supplierSku = product.sku;
        const internalSku = `${supplierSku}-${slugify(product.productColor || 'general')}`.toUpperCase();
        await client.query(
          `insert into products (id,name,sku,supplier_sku,internal_sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (sku) do nothing`,
          [product.id, product.name, internalSku, supplierSku, internalSku, product.category, product.productColor, product.cost, product.price, product.stock, product.threshold, product.description, product.emoji, product.themeColor]
        );
      }
      await client.query("select setval(pg_get_serial_sequence('products','id'), greatest((select max(id) from products), 1))");
      await client.query("insert into inventory_history (product_id,sku,action,details) select id,sku,'initial_seed',jsonb_build_object('stock',stock) from products");
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  const { rows: [{ count: userCount }] } = await pool.query('select count(*)::int as count from users');
  if (userCount === 0) {
    const adminPassword = process.env.TECNOLAND_ADMIN_PASSWORD || '';
    if (!adminPassword && isProduction) {
      throw new Error('Falta TECNOLAND_ADMIN_PASSWORD para crear el usuario administrador inicial en producción.');
    }
    const { salt, hash } = createPasswordHash(adminPassword);
    await pool.query(
      `insert into users (full_name, username, role, password_salt, password_hash)
       values ($1,$2,$3,$4,$5)`,
      ['Administrador Tecnoland', 'admin', 'admin', salt, hash]
    );
  }
}

const mapProduct = row => ({
  id: Number(row.id), name: row.name, sku: row.sku, category: row.category,
  supplierSku: row.supplier_sku || row.sku, internalSku: row.internal_sku || row.sku,
  active: row.active !== false,
  productColor: row.product_color, cost: Number(row.cost), price: Number(row.price),
  stock: row.stock, threshold: row.threshold, description: row.description,
  emoji: row.emoji, themeColor: row.theme_color, updatedAt: row.updated_at
});

const productValues = value => [
  String(value.name || '').trim(), String(value.sku || '').trim().toUpperCase(),
  String(value.category || '').trim(), String(value.productColor || 'Sin especificar').trim(),
  Number(value.cost || 0), Number(value.price || 0), Math.max(0, Number(value.stock || 0)),
  Math.max(0, Number(value.threshold || 0)), String(value.description || '').trim(),
  value.emoji || '📦', value.themeColor || '#e8ecf5'
];

function buildInternalSku(supplierSku, productColor) {
  return `${String(supplierSku || '').trim().toUpperCase()}-${slugify(productColor || 'general')}`.replace(/-+/g, '-').toUpperCase();
}

module.exports = { pool, ensureDatabase, mapProduct, productValues, buildInternalSku, defaultStorefrontSettings };

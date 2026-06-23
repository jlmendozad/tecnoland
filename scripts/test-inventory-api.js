const handler = require('../api/products');
const { pool } = require('../lib/database');

function request(method, route, body = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { if (this.statusCode >= 400) reject(new Error(data.error)); else resolve({ status: this.statusCode, data }); }
    };
    handler({ method, query: { route }, body }, response).catch(reject);
  });
}

async function run() {
  const sku = `QA-IMPORT-${Date.now()}`;
  const imported = await request('POST', 'bulk', { products: [{ sku, name: 'Producto temporal de prueba', category: 'Pruebas', productColor: 'Azul', cost: 10, price: 15, stock: 2, threshold: 1, description: 'Se elimina al terminar la prueba.' }] });
  if (imported.data.created !== 1) throw new Error('La importación no creó el producto temporal.');
  const { rows: [product] } = await pool.query('select id from products where sku=$1', [sku]);
  if (!product) throw new Error('El producto importado no se guardó.');
  await request('DELETE', String(product.id));
  const { rows: [result] } = await pool.query("select count(*)::int as count from inventory_history where sku=$1 and action in ('bulk_created','product_deleted')", [sku]);
  if (result.count !== 2) throw new Error('El historial de importación/eliminación está incompleto.');
  console.log('Importación, eliminación e historial verificados.');
}

run().finally(() => pool.end());

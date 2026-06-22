const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const dataDirectory = process.env.DATA_DIR || path.join(__dirname, 'data');
const databasePath = path.join(dataDirectory, 'inventory.json');
const historyPath = path.join(dataDirectory, 'inventory-history.jsonl');
const seedPath = path.join(__dirname, 'data', 'seed-products.json');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

fs.mkdirSync(dataDirectory, { recursive: true });
if (!fs.existsSync(databasePath)) fs.copyFileSync(seedPath, databasePath);

const readProducts = () => JSON.parse(fs.readFileSync(databasePath, 'utf8'));
const writeProducts = products => {
  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(products, null, 2));
  fs.renameSync(temporaryPath, databasePath);
};
const recordHistory = (action, product, details = {}) => fs.appendFileSync(historyPath, `${JSON.stringify({ timestamp: new Date().toISOString(), action, productId: product.id, sku: product.sku, ...details })}\n`);
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
const readBody = request => new Promise((resolve, reject) => { let body = ''; request.on('data', chunk => { body += chunk; if (body.length > 1e6) request.destroy(); }); request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); request.on('error', reject); });
const normalizeProduct = (value, current = {}) => ({
  ...current,
  ...value,
  id: current.id || Number(value.id) || Date.now(),
  name: String(value.name ?? current.name ?? '').trim(),
  sku: String(value.sku ?? current.sku ?? '').trim().toUpperCase(),
  category: String(value.category ?? current.category ?? '').trim(),
  productColor: String(value.productColor ?? value.variantColor ?? current.productColor ?? 'Sin especificar').trim(),
  themeColor: value.themeColor ?? value.color ?? current.themeColor ?? '#e8ecf5',
  cost: Number(value.cost ?? current.cost ?? 0),
  price: Number(value.price ?? current.price ?? 0),
  stock: Math.max(0, Number(value.stock ?? current.stock ?? 0)),
  threshold: Math.max(0, Number(value.threshold ?? current.threshold ?? 0)),
  updatedAt: new Date().toISOString()
});

async function handleApi(request, response, pathname) {
  const products = readProducts();
  if (request.method === 'GET' && pathname === '/api/products') return json(response, 200, products);
  if (request.method === 'POST' && pathname === '/api/products/import') {
    const body = await readBody(request); let imported = 0;
    for (const raw of body.products || []) { const index = products.findIndex(product => product.sku === raw.sku); const product = normalizeProduct(raw, index >= 0 ? products[index] : {}); if (index >= 0) products[index] = product; else products.unshift(product); recordHistory('migration_import', product); imported += 1; }
    writeProducts(products); return json(response, 200, { imported });
  }
  if (request.method === 'POST' && pathname === '/api/products') {
    const product = normalizeProduct(await readBody(request));
    if (!product.name || !product.sku) return json(response, 400, { error: 'Nombre y SKU son obligatorios.' });
    if (products.some(item => item.sku === product.sku)) return json(response, 409, { error: 'Ya existe un producto con ese SKU.' });
    products.unshift(product); writeProducts(products); recordHistory('product_created', product, { stock: product.stock }); return json(response, 201, product);
  }
  const match = pathname.match(/^\/api\/products\/(\d+)(\/stock)?$/);
  if (!match) return json(response, 404, { error: 'Ruta no encontrada.' });
  const index = products.findIndex(product => product.id === Number(match[1]));
  if (index < 0) return json(response, 404, { error: 'Producto no encontrado.' });
  if (request.method === 'PUT' && !match[2]) {
    const previous = products[index]; const product = normalizeProduct(await readBody(request), previous);
    if (products.some((item, itemIndex) => item.sku === product.sku && itemIndex !== index)) return json(response, 409, { error: 'Ya existe un producto con ese SKU.' });
    products[index] = product; writeProducts(products); recordHistory('product_updated', product, { previousStock: previous.stock, stock: product.stock }); return json(response, 200, product);
  }
  if (request.method === 'PATCH' && match[2]) {
    const body = await readBody(request); const previousStock = products[index].stock; products[index] = normalizeProduct({ stock: previousStock + Number(body.adjustment || 0) }, products[index]);
    writeProducts(products); recordHistory('stock_adjusted', products[index], { previousStock, stock: products[index].stock, adjustment: products[index].stock - previousStock }); return json(response, 200, products[index]);
  }
  return json(response, 405, { error: 'Método no permitido.' });
}

const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(request.url.split('?')[0]);
  try {
    if (pathname.startsWith('/api/')) return await handleApi(request, response, pathname);
    const requestPath = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(__dirname, requestPath);
    if (!filePath.startsWith(__dirname)) { response.writeHead(403).end('Forbidden'); return; }
    fs.readFile(filePath, (error, content) => { if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found'); return; } response.writeHead(200, { 'Content-Type': `${types[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` }); response.end(content); });
  } catch (error) { json(response, 400, { error: 'La solicitud no pudo procesarse.' }); }
});

if (require.main === module) server.listen(port, host, () => console.log(`Tecnoland disponible en http://${host}:${port}`));

module.exports = { normalizeProduct, server };

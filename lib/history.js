// Registro de cambios del inventario: quién hizo cada cambio y cómo estaba el
// producto antes y después, para poder consultarlo y deshacerlo desde el panel.

// Campos que se comparan y que se pueden restaurar.
const TRACKED_FIELDS = ['name', 'supplierSku', 'internalSku', 'category', 'productColor', 'cost', 'price', 'stock', 'threshold', 'description', 'active'];

const COLUMN_BY_FIELD = {
  name: 'name',
  supplierSku: 'supplier_sku',
  internalSku: 'internal_sku',
  category: 'category',
  productColor: 'product_color',
  cost: 'cost',
  price: 'price',
  stock: 'stock',
  threshold: 'threshold',
  description: 'description',
  active: 'active'
};

// Acciones que se pueden deshacer cuando el registro guarda el estado anterior.
const RESTORABLE_ACTIONS = new Set(['product_updated', 'product_deleted', 'product_activated', 'product_deactivated', 'stock_adjusted', 'bulk_updated', 'product_restored']);

function snapshot(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    sku: row.sku,
    supplierSku: row.supplier_sku || row.sku,
    internalSku: row.internal_sku || row.sku,
    category: row.category,
    productColor: row.product_color,
    cost: Number(row.cost),
    price: Number(row.price),
    stock: Number(row.stock),
    threshold: Number(row.threshold),
    description: row.description || '',
    active: row.active !== false,
    emoji: row.emoji,
    themeColor: row.theme_color
  };
}

function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return (a ?? '') === (b ?? '');
}

function changedFields(before, after) {
  if (!before || !after) return [];
  return TRACKED_FIELDS.filter(field => !sameValue(before[field], after[field]));
}

function actor(session) {
  if (!session) return { userId: null, userName: null };
  const userId = Number(session.sub);
  return { userId: Number.isSafeInteger(userId) ? userId : null, userName: session.name || session.username || null };
}

async function recordHistory(db, { productId = null, sku = null, action, session, before = null, after = null, details = {} }) {
  const { userId, userName } = actor(session);
  await db.query(
    `insert into inventory_history (product_id, sku, action, details, user_id, user_name, before_state, after_state)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb)`,
    [productId, sku, action, JSON.stringify(details || {}), userId, userName, before && JSON.stringify(before), after && JSON.stringify(after)]
  );
}

// Inserta muchos registros en una sola consulta (importaciones de hasta 1,000 filas).
async function recordHistoryBatch(db, entries, session) {
  if (!entries.length) return;
  const { userId, userName } = actor(session);
  const rows = entries.map(entry => ({
    product_id: entry.productId ?? null,
    sku: entry.sku ?? null,
    action: entry.action,
    details: entry.details || {},
    before_state: entry.before || null,
    after_state: entry.after || null
  }));
  await db.query(
    `insert into inventory_history (product_id, sku, action, details, user_id, user_name, before_state, after_state)
     select product_id, sku, action, coalesce(details, '{}'::jsonb), $2, $3, before_state, after_state
     from jsonb_to_recordset($1::jsonb) as x(product_id bigint, sku text, action text, details jsonb, before_state jsonb, after_state jsonb)`,
    [JSON.stringify(rows), userId, userName]
  );
}

module.exports = { TRACKED_FIELDS, COLUMN_BY_FIELD, RESTORABLE_ACTIONS, snapshot, changedFields, recordHistory, recordHistoryBatch, actor };

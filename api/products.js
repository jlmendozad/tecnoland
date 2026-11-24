const { pool, ensureDatabase, mapProduct, productValues, buildInternalSku } = require('../lib/database');
const { sessionFromRequest } = require('../lib/security');
const { COLUMN_BY_FIELD, RESTORABLE_ACTIONS, snapshot, changedFields, recordHistory, recordHistoryBatch } = require('../lib/history');

const sendError = (response, error) => {
  if (error.code === '23505') return response.status(409).json({ error: 'Ya existe un producto con ese SKU y color.' });
  console.error(error);
  return response.status(500).json({ error: 'No fue posible procesar la solicitud.' });
};

const IMAGE_REF = /^\/api\/images\/(\d+)(?:\?.*)?$/;

// Una foto ya guardada viaja al navegador como "/api/images/<id>". Al guardar el
// producto, esas referencias se convierten de nuevo en la foto original antes de
// reemplazar la lista, para no perder fotos que no cambiaron.
async function syncProductImages(client, productId, images = []) {
  const incoming = images.map(image => String((image && typeof image === 'object' ? image.url : image) || '').trim()).filter(Boolean);
  const referencedIds = incoming.map(url => IMAGE_REF.exec(url)?.[1]).filter(Boolean).map(Number);
  const existing = new Map();
  if (referencedIds.length) {
    const { rows } = await client.query('select id, image_url from product_images where id = any($1::bigint[])', [referencedIds]);
    rows.forEach(row => existing.set(Number(row.id), row.image_url));
  }
  const resolved = incoming.map(url => {
    const ref = IMAGE_REF.exec(url);
    return ref ? existing.get(Number(ref[1])) : url;
  }).filter(Boolean);
  await client.query('delete from product_images where product_id=$1', [productId]);
  for (let index = 0; index < resolved.length; index += 1) {
    await client.query('insert into product_images (product_id, image_url, sort_order) values ($1,$2,$3)', [productId, resolved[index], index]);
  }
}

// Columnas de product_images sin el contenido pesado de las fotos guardadas en la base.
const IMAGE_COLUMNS = "id, product_id, sort_order, case when image_url like 'data:%' then null else image_url end as external_url";
const imageEntry = row => ({ url: row.external_url || `/api/images/${row.id}`, sortOrder: row.sort_order });

async function productResponse(client, product) {
  const source = client || pool;
  const { rows } = await source.query(
    `select ${IMAGE_COLUMNS} from product_images where product_id=$1 order by sort_order asc, id asc`,
    [product.id]
  );
  return {
    ...mapProduct(product),
    images: rows.map(imageEntry)
  };
}

const HISTORY_ACTION_GROUPS = {
  edits: ['product_updated', 'product_restored'],
  stock: ['stock_adjusted'],
  status: ['product_activated', 'product_deactivated'],
  created: ['product_created', 'bulk_created', 'migration_import', 'initial_seed'],
  deleted: ['product_deleted'],
  imports: ['bulk_created', 'bulk_updated', 'migration_import'],
  orders: ['order_created', 'order_deleted'],
  users: ['password_reset']
};

const HISTORY_NAME = "coalesce(p.name, h.after_state->>'name', h.before_state->>'name', h.details->'product'->>'name', '')";

function historyEntry(row) {
  const before = row.before_state || null;
  const after = row.after_state || null;
  const productExists = row.current_product_id !== null && row.current_product_id !== undefined;
  let restorable = RESTORABLE_ACTIONS.has(row.action) && Boolean(before);
  if (restorable && row.action === 'product_deleted') restorable = !productExists;
  else if (restorable) restorable = productExists && changedFields(before, after).length > 0;
  const details = { ...(row.details || {}) };
  delete details.images;
  return {
    id: Number(row.id),
    productId: row.product_id === null ? null : Number(row.product_id),
    sku: row.sku,
    productName: row.product_name || '',
    action: row.action,
    userId: row.user_id === null ? null : Number(row.user_id),
    userName: row.user_name || '',
    before,
    after,
    changedFields: changedFields(before, after),
    details,
    restorable,
    createdAt: row.created_at
  };
}

async function listHistory(request, response) {
  const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
  const beforeId = Number(request.query.beforeId) || null;
  const search = String(request.query.q || '').trim().replace(/[\\%_]/g, character => `\\${character}`);
  const userId = Number(request.query.userId) || null;
  const actions = HISTORY_ACTION_GROUPS[String(request.query.action || '')] || null;
  const { rows } = await pool.query(
    `select h.id, h.product_id, h.sku, h.action, h.details, h.user_id, h.user_name, h.before_state, h.after_state, h.created_at,
            p.id as current_product_id, ${HISTORY_NAME} as product_name
     from inventory_history h left join products p on p.id = h.product_id
     where ($1::bigint is null or h.id < $1)
       and ($2::text = '' or h.sku ilike '%' || $2 || '%' or ${HISTORY_NAME} ilike '%' || $2 || '%')
       and ($3::bigint is null or h.user_id = $3)
       and ($4::text[] is null or h.action = any($4))
     order by h.id desc
     limit $5`,
    [beforeId, search, userId, actions, limit + 1]
  );
  const payload = { entries: rows.slice(0, limit).map(historyEntry), hasMore: rows.length > limit };
  if (!beforeId) {
    const { rows: users } = await pool.query(
      `select distinct on (user_id) user_id, user_name from inventory_history where user_id is not null order by user_id, id desc`
    );
    payload.users = users.map(user => ({ id: Number(user.user_id), name: user.user_name || `Usuario ${user.user_id}` }));
  }
  return response.status(200).json(payload);
}

// Deshace un cambio puntual. Solo se regresan los campos que ese cambio modificó;
// el stock se corrige por la diferencia de ese cambio, para no borrar ventas o
// ajustes que pasaron después.
async function restoreHistory(response, historyId, session) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [entry] } = await client.query('select * from inventory_history where id=$1 for update', [historyId]);
    if (!entry) { await client.query('rollback'); return response.status(404).json({ error: 'No encontramos ese registro del historial.' }); }
    const before = entry.before_state;
    if (!RESTORABLE_ACTIONS.has(entry.action) || !before) {
      await client.query('rollback');
      return response.status(400).json({ error: 'Este cambio no se puede restaurar.' });
    }

    if (entry.action === 'product_deleted') {
      const { rows: [current] } = await client.query('select id from products where id=$1', [before.id]);
      if (current) { await client.query('rollback'); return response.status(409).json({ error: 'Ese producto ya existe; no hace falta restaurarlo.' }); }
      const { rows: [product] } = await client.query(
        `insert into products (id,name,sku,supplier_sku,internal_sku,active,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
         overriding system value values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [before.id, before.name, before.internalSku || before.sku, before.supplierSku || before.sku, before.internalSku || before.sku, before.active !== false,
          before.category, before.productColor || 'Sin especificar', before.cost, before.price, before.stock, before.threshold, before.description || '',
          before.emoji || '📦', before.themeColor || '#e8ecf5']
      );
      const images = Array.isArray(entry.details?.images) ? entry.details.images : [];
      for (let index = 0; index < images.length; index += 1) {
        await client.query('insert into product_images (product_id, image_url, sort_order) values ($1,$2,$3)', [product.id, images[index], index]);
      }
      await client.query("select setval(pg_get_serial_sequence('products','id'), greatest((select max(id) from products), 1))");
      // Al borrarse el producto su historial quedó sin enlace; se vuelve a conectar.
      await client.query(
        `update inventory_history set product_id=$1
         where product_id is null and ((before_state->>'id')::bigint = $1 or (after_state->>'id')::bigint = $1)`,
        [product.id]
      );
      await recordHistory(client, { productId: product.id, sku: product.sku, action: 'product_restored', session, after: snapshot(product), details: { restoredFromHistoryId: historyId, restoredAction: entry.action } });
      const payload = await productResponse(client, product);
      await client.query('commit');
      return response.status(200).json({ product: payload, restoredFields: [] });
    }

    const { rows: [current] } = await client.query('select * from products where id=$1 for update', [entry.product_id]);
    if (!current) { await client.query('rollback'); return response.status(404).json({ error: 'El producto ya no existe. Restaura primero su eliminación.' }); }
    const fields = changedFields(before, entry.after_state);
    if (!fields.length) { await client.query('rollback'); return response.status(400).json({ error: 'Ese cambio no modificó datos que se puedan restaurar.' }); }

    const assignments = [];
    const values = [current.id];
    const set = (column, value) => { values.push(value); assignments.push(`${column}=$${values.length}`); };
    for (const field of fields) {
      if (field === 'stock') {
        const delta = Number(entry.after_state.stock) - Number(before.stock);
        set('stock', Math.max(0, Number(current.stock) - delta));
      } else if (field === 'internalSku') {
        set('internal_sku', before.internalSku);
        set('sku', before.internalSku);
      } else {
        set(COLUMN_BY_FIELD[field], before[field]);
      }
    }
    const { rows: [product] } = await client.query(`update products set ${assignments.join(', ')}, updated_at=now() where id=$1 returning *`, values);
    const beforeRestore = snapshot(current), afterRestore = snapshot(product);
    await recordHistory(client, {
      productId: product.id, sku: product.sku, action: 'product_restored', session, before: beforeRestore, after: afterRestore,
      details: { restoredFromHistoryId: historyId, restoredAction: entry.action, changedFields: changedFields(beforeRestore, afterRestore) }
    });
    const payload = await productResponse(client, product);
    await client.query('commit');
    return response.status(200).json({ product: payload, restoredFields: fields });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function publicProductResponse(product, images = []) {
  const mapped = mapProduct(product);
  return {
    id: mapped.id,
    name: mapped.name,
    category: mapped.category,
    productColor: mapped.productColor,
    price: mapped.price,
    stock: mapped.stock,
    description: mapped.description,
    emoji: mapped.emoji,
    themeColor: mapped.themeColor,
    images,
    updatedAt: mapped.updatedAt
  };
}

function requireAdmin(request, response) {
  const session = sessionFromRequest(request);
  if (!session) {
    response.status(401).json({ error: 'Acceso no autorizado.' });
    return null;
  }
  return session;
}

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    const route = String(request.query.route || '').replace(/^\/+|\/+$/g, '');

    if (request.method === 'GET' && !route) {
      const session = sessionFromRequest(request);
      const { rows } = await pool.query(
        session
          ? 'select * from products order by created_at desc, id desc'
          : 'select * from products where active=true order by created_at desc, id desc'
      );
      const ids = rows.map(row => row.id);
      const imageRows = ids.length ? await pool.query(`select ${IMAGE_COLUMNS} from product_images where product_id = any($1::bigint[]) order by sort_order asc, id asc`, [ids]) : { rows: [] };
      const imagesByProduct = new Map();
      for (const image of imageRows.rows) {
        const list = imagesByProduct.get(String(image.product_id)) || [];
        list.push(imageEntry(image));
        imagesByProduct.set(String(image.product_id), list);
      }
      return response.status(200).json(
        rows.map(row => {
          const images = imagesByProduct.get(String(row.id)) || [];
          return session ? { ...mapProduct(row), images } : publicProductResponse(row, images);
        })
      );
    }

    const session = requireAdmin(request, response);
    if (!session) return;

    if (request.method === 'GET' && route === 'history') return await listHistory(request, response);
    const restoreMatch = route.match(/^history\/(\d+)\/restore$/);
    if (request.method === 'POST' && restoreMatch) return await restoreHistory(response, Number(restoreMatch[1]), session);

    if (request.method === 'POST' && route === 'import') {
      const client = await pool.connect(); let imported = 0;
      try {
        await client.query('begin');
        for (const raw of request.body.products || []) {
          const values = productValues({ ...raw, productColor: raw.productColor || raw.variantColor });
          const supplierSku = String(raw.sku || '').trim().toUpperCase();
          const internalSku = buildInternalSku(supplierSku, raw.productColor || raw.variantColor);
          const { rows: [product] } = await client.query(
            `insert into products (name,sku,supplier_sku,internal_sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             on conflict (sku) do update set name=excluded.name,supplier_sku=excluded.supplier_sku,internal_sku=excluded.internal_sku,category=excluded.category,product_color=excluded.product_color,cost=excluded.cost,price=excluded.price,stock=excluded.stock,threshold=excluded.threshold,description=excluded.description,emoji=excluded.emoji,theme_color=excluded.theme_color,updated_at=now()
             returning *`,
            [values[0], internalSku, supplierSku, internalSku, values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10]]
          );
          await recordHistory(client, { productId: product.id, sku: product.sku, action: 'migration_import', session, after: snapshot(product), details: { stock: product.stock } });
          imported += 1;
        }
        await client.query('commit'); return response.status(200).json({ imported });
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'POST' && route === 'bulk') {
      const incoming = Array.isArray(request.body.products) ? request.body.products : [];
      const mergeStrategy = request.body.mergeStrategy === 'add' ? 'add' : 'replace';
      if (!incoming.length || incoming.length > 1000) return response.status(400).json({ error: 'La importación debe contener entre 1 y 1,000 productos.' });
      const rows = incoming.map(product => {
        const values = productValues(product);
        const internalSku = buildInternalSku(values[1], values[3]);
        return { name: values[0], sku: internalSku, supplier_sku: values[1], internal_sku: internalSku, category: values[2], product_color: values[3], cost: values[4], price: values[5], stock: values[6], threshold: values[7], description: values[8], emoji: values[9], theme_color: values[10] };
      });
      if (rows.some(product => !product.name || !product.sku || !Number.isFinite(product.cost) || !Number.isFinite(product.price))) return response.status(400).json({ error: 'Hay productos con campos obligatorios o importes inválidos.' });
      if (new Set(rows.map(product => product.sku)).size !== rows.length) return response.status(400).json({ error: 'El archivo contiene combinaciones de SKU y color duplicadas.' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const skus = rows.map(product => product.sku);
        const { rows: existingRows } = await client.query('select * from products where sku=any($1::text[]) for update', [skus]);
        const existing = existingRows.map(product => product.sku);
        const beforeBySku = new Map(existingRows.map(product => [product.sku, snapshot(product)]));
        await client.query(
          `insert into products (name,sku,supplier_sku,internal_sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
           select name,sku,supplier_sku,internal_sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color
           from jsonb_to_recordset($1::jsonb) as x(name text,sku text,supplier_sku text,internal_sku text,category text,product_color text,cost numeric,price numeric,stock integer,threshold integer,description text,emoji text,theme_color text)
           on conflict (sku) do update set name=excluded.name,supplier_sku=excluded.supplier_sku,internal_sku=excluded.internal_sku,category=excluded.category,product_color=excluded.product_color,cost=excluded.cost,price=excluded.price,stock=case when $2 = 'add' then products.stock + excluded.stock else excluded.stock end,threshold=excluded.threshold,description=excluded.description,emoji=excluded.emoji,theme_color=excluded.theme_color,updated_at=now()`,
          [JSON.stringify(rows), mergeStrategy]
        );
        const { rows: afterRows } = await client.query('select * from products where sku=any($1::text[])', [skus]);
        await recordHistoryBatch(client, afterRows.map(product => {
          const before = beforeBySku.get(product.sku) || null;
          const after = snapshot(product);
          return {
            productId: product.id, sku: product.sku, action: before ? 'bulk_updated' : 'bulk_created', before, after,
            details: { stock: product.stock, source: 'spreadsheet', changedFields: changedFields(before, after) }
          };
        }), session);
        await client.query('commit');
        return response.status(200).json({ created: rows.length - existing.length, updated: existing.length });
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'POST' && !route) {
      const values = productValues(request.body);
      if (!values[0] || !values[1]) return response.status(400).json({ error: 'Nombre y SKU son obligatorios.' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const internalSku = buildInternalSku(values[1], values[3]);
        const { rows: [product] } = await client.query(
          `insert into products (name,sku,supplier_sku,internal_sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
          [values[0], internalSku, values[1], internalSku, values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10]]
        );
        await syncProductImages(client, product.id, Array.isArray(request.body.images) ? request.body.images : []);
        await recordHistory(client, { productId: product.id, sku: product.sku, action: 'product_created', session, after: snapshot(product), details: { stock: product.stock } });
        const payload = await productResponse(client, product);
        await client.query('commit'); return response.status(201).json(payload);
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    const match = route.match(/^(\d+)(\/(?:stock|active))?$/);
    if (!match) return response.status(404).json({ error: 'Ruta no encontrada.' });
    const id = Number(match[1]);

    if (request.method === 'DELETE' && !match[2]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [product] } = await client.query('select * from products where id=$1 for update', [id]);
        if (!product) { await client.query('rollback'); return response.status(404).json({ error: 'Producto no encontrado.' }); }
        const { rows: deletedImages } = await client.query('select image_url from product_images where product_id=$1 order by sort_order asc, id asc', [id]);
        await recordHistory(client, { productId: id, sku: product.sku, action: 'product_deleted', session, before: snapshot(product), details: { product: mapProduct(product), images: deletedImages.map(image => image.image_url) } });
        await client.query('delete from products where id=$1', [id]);
        await client.query('commit'); return response.status(200).json({ deleted: true, id });
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'PUT' && !match[2]) {
      const values = productValues(request.body);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [previous] } = await client.query('select * from products where id=$1 for update', [id]);
        if (!previous) { await client.query('rollback'); return response.status(404).json({ error: 'Producto no encontrado.' }); }
        const internalSku = buildInternalSku(values[1], values[3]);
        const { rows: [product] } = await client.query(
          `update products set name=$1,sku=$2,supplier_sku=$3,internal_sku=$4,category=$5,product_color=$6,cost=$7,price=$8,stock=$9,threshold=$10,description=$11,emoji=$12,theme_color=$13,updated_at=now() where id=$14 returning *`,
          [values[0], internalSku, values[1], internalSku, values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10], id]
        );
        await syncProductImages(client, product.id, Array.isArray(request.body.images) ? request.body.images : []);
        const before = snapshot(previous), after = snapshot(product);
        await recordHistory(client, { productId: id, sku: product.sku, action: 'product_updated', session, before, after, details: { previousStock: previous.stock, stock: product.stock, changedFields: changedFields(before, after) } });
        const payload = await productResponse(client, product);
        await client.query('commit'); return response.status(200).json(payload);
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'PATCH' && match[2]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [previous] } = await client.query('select * from products where id=$1 for update', [id]);
        if (!previous) { await client.query('rollback'); return response.status(404).json({ error: 'Producto no encontrado.' }); }
        if (match[2] === '/active') {
          const active = typeof request.body.active === 'boolean' ? request.body.active : !previous.active;
          const { rows: [product] } = await client.query('update products set active=$1,updated_at=now() where id=$2 returning *', [active, id]);
          await recordHistory(client, { productId: id, sku: product.sku, action: active ? 'product_activated' : 'product_deactivated', session, before: snapshot(previous), after: snapshot(product), details: { active } });
          const payload = await productResponse(client, product);
          await client.query('commit'); return response.status(200).json(payload);
        }
        const adjustment = Number(request.body.adjustment || 0);
        const stock = Math.max(0, previous.stock + adjustment);
        const { rows: [product] } = await client.query('update products set stock=$1,updated_at=now() where id=$2 returning *', [stock, id]);
        await recordHistory(client, { productId: id, sku: product.sku, action: 'stock_adjusted', session, before: snapshot(previous), after: snapshot(product), details: { previousStock: previous.stock, stock, adjustment: stock - previous.stock } });
        const payload = await productResponse(client, product);
        await client.query('commit'); return response.status(200).json(payload);
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    return response.status(405).json({ error: 'Método no permitido.' });
  } catch (error) { return sendError(response, error); }
};

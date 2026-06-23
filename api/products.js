const { pool, ensureDatabase, mapProduct, productValues } = require('../lib/database');

const sendError = (response, error) => {
  if (error.code === '23505') return response.status(409).json({ error: 'Ya existe un producto con ese SKU.' });
  console.error(error);
  return response.status(500).json({ error: 'No fue posible procesar la solicitud.' });
};

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    const route = String(request.query.route || '').replace(/^\/+|\/+$/g, '');

    if (request.method === 'GET' && !route) {
      const { rows } = await pool.query('select * from products order by created_at desc, id desc');
      return response.status(200).json(rows.map(mapProduct));
    }

    if (request.method === 'POST' && route === 'import') {
      const client = await pool.connect(); let imported = 0;
      try {
        await client.query('begin');
        for (const raw of request.body.products || []) {
          const values = productValues({ ...raw, productColor: raw.productColor || raw.variantColor });
          const { rows: [product] } = await client.query(
            `insert into products (name,sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             on conflict (sku) do update set name=excluded.name,category=excluded.category,product_color=excluded.product_color,cost=excluded.cost,price=excluded.price,stock=excluded.stock,threshold=excluded.threshold,description=excluded.description,emoji=excluded.emoji,theme_color=excluded.theme_color,updated_at=now()
             returning *`, values
          );
          await client.query("insert into inventory_history(product_id,sku,action,details) values($1,$2,'migration_import',$3)", [product.id, product.sku, { stock: product.stock }]);
          imported += 1;
        }
        await client.query('commit'); return response.status(200).json({ imported });
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'POST' && route === 'bulk') {
      const incoming = Array.isArray(request.body.products) ? request.body.products : [];
      if (!incoming.length || incoming.length > 1000) return response.status(400).json({ error: 'La importación debe contener entre 1 y 1,000 productos.' });
      const rows = incoming.map(product => { const values = productValues(product); return { name: values[0], sku: values[1], category: values[2], product_color: values[3], cost: values[4], price: values[5], stock: values[6], threshold: values[7], description: values[8], emoji: values[9], theme_color: values[10] }; });
      if (rows.some(product => !product.name || !product.sku || !Number.isFinite(product.cost) || !Number.isFinite(product.price))) return response.status(400).json({ error: 'Hay productos con campos obligatorios o importes inválidos.' });
      if (new Set(rows.map(product => product.sku)).size !== rows.length) return response.status(400).json({ error: 'El archivo contiene SKU duplicados.' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const skus = rows.map(product => product.sku);
        const { rows: existingRows } = await client.query('select sku from products where sku=any($1::text[])', [skus]);
        const existing = existingRows.map(product => product.sku);
        await client.query(
          `insert into products (name,sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
           select name,sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color
           from jsonb_to_recordset($1::jsonb) as x(name text,sku text,category text,product_color text,cost numeric,price numeric,stock integer,threshold integer,description text,emoji text,theme_color text)
           on conflict (sku) do update set name=excluded.name,category=excluded.category,product_color=excluded.product_color,cost=excluded.cost,price=excluded.price,stock=excluded.stock,threshold=excluded.threshold,description=excluded.description,emoji=excluded.emoji,theme_color=excluded.theme_color,updated_at=now()`,
          [JSON.stringify(rows)]
        );
        await client.query(
          `insert into inventory_history(product_id,sku,action,details)
           select id,sku,case when sku=any($2::text[]) then 'bulk_updated' else 'bulk_created' end,jsonb_build_object('stock',stock,'source','spreadsheet')
           from products where sku=any($1::text[])`, [skus, existing]
        );
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
        const { rows: [product] } = await client.query(
          `insert into products (name,sku,category,product_color,cost,price,stock,threshold,description,emoji,theme_color)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`, values
        );
        await client.query("insert into inventory_history(product_id,sku,action,details) values($1,$2,'product_created',$3)", [product.id, product.sku, { stock: product.stock }]);
        await client.query('commit'); return response.status(201).json(mapProduct(product));
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    const match = route.match(/^(\d+)(\/stock)?$/);
    if (!match) return response.status(404).json({ error: 'Ruta no encontrada.' });
    const id = Number(match[1]);

    if (request.method === 'DELETE' && !match[2]) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [product] } = await client.query('select * from products where id=$1 for update', [id]);
        if (!product) { await client.query('rollback'); return response.status(404).json({ error: 'Producto no encontrado.' }); }
        await client.query("insert into inventory_history(product_id,sku,action,details) values($1,$2,'product_deleted',$3)", [id, product.sku, { product: mapProduct(product) }]);
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
        const { rows: [product] } = await client.query(
          `update products set name=$1,sku=$2,category=$3,product_color=$4,cost=$5,price=$6,stock=$7,threshold=$8,description=$9,emoji=$10,theme_color=$11,updated_at=now() where id=$12 returning *`,
          [...values, id]
        );
        await client.query("insert into inventory_history(product_id,sku,action,details) values($1,$2,'product_updated',$3)", [id, product.sku, { previousStock: previous.stock, stock: product.stock }]);
        await client.query('commit'); return response.status(200).json(mapProduct(product));
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    if (request.method === 'PATCH' && match[2]) {
      const adjustment = Number(request.body.adjustment || 0); const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [previous] } = await client.query('select * from products where id=$1 for update', [id]);
        if (!previous) { await client.query('rollback'); return response.status(404).json({ error: 'Producto no encontrado.' }); }
        const stock = Math.max(0, previous.stock + adjustment);
        const { rows: [product] } = await client.query('update products set stock=$1,updated_at=now() where id=$2 returning *', [stock, id]);
        await client.query("insert into inventory_history(product_id,sku,action,details) values($1,$2,'stock_adjusted',$3)", [id, product.sku, { previousStock: previous.stock, stock, adjustment: stock - previous.stock }]);
        await client.query('commit'); return response.status(200).json(mapProduct(product));
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    return response.status(405).json({ error: 'Método no permitido.' });
  } catch (error) { return sendError(response, error); }
};

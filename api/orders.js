const { pool, ensureDatabase, mapProduct } = require('../lib/database');
const { verifySession } = require('../lib/security');

function sessionFromRequest(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifySession(token);
}

async function orderResponse(orderId) {
  const { rows: [order] } = await pool.query('select * from orders where id=$1', [orderId]);
  const { rows: items } = await pool.query('select * from order_items where order_id=$1 order by id asc', [orderId]);
  return {
    id: Number(order.id),
    orderNumber: order.order_number,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerAddress: order.customer_address,
    customerNote: order.customer_note,
    internalNote: order.internal_note,
    courierCompany: order.courier_company,
    trackingNumber: order.tracking_number,
    deliveryMethod: order.delivery_method,
    paymentMethod: order.payment_method,
    status: order.status,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    total: Number(order.total),
    costTotal: Number(order.cost_total),
    marginTotal: Number(order.margin_total),
    courierHandoffAt: order.courier_handoff_at,
    estimatedDeliveryAt: order.estimated_delivery_at,
    deliveredAt: order.delivered_at,
    createdAt: order.created_at,
    createdByUserId: order.created_by_user_id,
    items: items.map(item => ({ id: Number(item.id), productId: item.product_id, sku: item.sku, productName: item.product_name, productColor: item.product_color, quantity: item.quantity, unitCost: Number(item.unit_cost), unitPrice: Number(item.unit_price), subtotal: Number(item.subtotal) }))
  };
}

module.exports = async function handler(request, response) {
  try {
    await ensureDatabase();
    const session = sessionFromRequest(request);
    if (!session) return response.status(401).json({ error: 'Acceso no autorizado.' });
    const route = String(request.query?.route || '').replace(/^\/+|\/+$/g, '');

    if (request.method === 'GET' && !route) {
      const { rows } = await pool.query('select * from orders order by created_at desc, id desc limit 100');
      return response.status(200).json(rows.map(row => ({ id: Number(row.id), orderNumber: row.order_number, customerName: row.customer_name, status: row.status, total: Number(row.total), marginTotal: Number(row.margin_total), paymentMethod: row.payment_method, deliveryMethod: row.delivery_method, createdAt: row.created_at })));
    }

    if (request.method === 'POST') {
      const { customer = {}, items = [], discount = 0, internalNote = '', courierCompany = '', trackingNumber = '', paymentMethod = 'transfer', deliveryMethod = 'courier' } = request.body || {};
      if (!customer.name || !Array.isArray(items) || !items.length) return response.status(400).json({ error: 'Cliente y productos son obligatorios.' });
      const client = await pool.connect();
      try {
        await client.query('begin');
        const orderItems = [];
        let subtotal = 0; let costTotal = 0;
        for (const item of items) {
          const quantity = Math.max(1, Number(item.quantity || 0));
          const { rows: [product] } = await client.query('select * from products where id=$1 for update', [item.productId]);
          if (!product || product.stock < quantity) throw new Error(`Stock insuficiente para ${item.productName || item.sku || 'un producto'}.`);
          const lineSubtotal = Number(product.price) * quantity;
          subtotal += lineSubtotal;
          costTotal += Number(product.cost) * quantity;
          await client.query('update products set stock=stock-$2, updated_at=now() where id=$1', [product.id, quantity]);
          orderItems.push({ product, quantity, subtotal: lineSubtotal });
        }
        const total = Math.max(0, subtotal - Number(discount || 0));
        const marginTotal = total - costTotal;
        const orderNumber = `TR-${String(Date.now()).slice(-4)}`;
        const { rows: [order] } = await client.query(
          `insert into orders (order_number, created_by_user_id, customer_name, customer_phone, customer_address, customer_note, internal_note, courier_company, tracking_number, delivery_method, payment_method, status, subtotal, discount, total, cost_total, margin_total, courier_handoff_at, estimated_delivery_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
          [orderNumber, session.sub, customer.name, customer.phone || '', customer.address || '', customer.note || '', internalNote || '', courierCompany || '', trackingNumber || '', deliveryMethod, paymentMethod, request.body.status || 'pending', subtotal, Number(discount || 0), total, costTotal, marginTotal, request.body.courierHandoffAt || null, request.body.estimatedDeliveryAt || null]
        );
        for (const entry of orderItems) {
          await client.query(
            'insert into order_items (order_id, product_id, sku, product_name, product_color, quantity, unit_cost, unit_price, subtotal) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [order.id, entry.product.id, entry.product.sku, entry.product.name, entry.product.product_color, entry.quantity, entry.product.cost, entry.product.price, entry.subtotal]
          );
        }
        await client.query(
          "insert into inventory_history(product_id,sku,action,details) select id,sku,'order_created',jsonb_build_object('orderNumber',$1::text,'items',$2::jsonb) from products where id = any($3::bigint[])",
          [orderNumber, JSON.stringify(orderItems.map(item => ({ productId: item.product.id, quantity: item.quantity }))), orderItems.map(item => Number(item.product.id))]
        );
        await client.query('commit');
        return response.status(201).json(await orderResponse(order.id));
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }

    const id = Number(route);
    if (!Number.isFinite(id)) return response.status(404).json({ error: 'Ruta no encontrada.' });
    if (request.method === 'PATCH') {
      const { status, courierCompany, trackingNumber, courierHandoffAt, estimatedDeliveryAt, deliveredAt } = request.body || {};
      const { rows: [updated] } = await pool.query(
        `update orders set status=coalesce($2,status), courier_company=coalesce($3,courier_company), tracking_number=coalesce($4,tracking_number), courier_handoff_at=coalesce($5,courier_handoff_at), estimated_delivery_at=coalesce($6,estimated_delivery_at), delivered_at=coalesce($7,delivered_at), updated_at=now() where id=$1 returning *`,
        [id, status, courierCompany, trackingNumber, courierHandoffAt || null, estimatedDeliveryAt || null, deliveredAt || null]
      );
      if (!updated) return response.status(404).json({ error: 'Pedido no encontrado.' });
      return response.status(200).json(await orderResponse(id));
    }
    if (request.method === 'DELETE') {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: [order] } = await client.query('select * from orders where id=$1 for update', [id]);
        if (!order) { await client.query('rollback'); return response.status(404).json({ error: 'Pedido no encontrado.' }); }
        const { rows: items } = await client.query('select * from order_items where order_id=$1 order by id asc', [id]);
        for (const item of items) {
          if (item.product_id) {
            await client.query('update products set stock=stock+$2, updated_at=now() where id=$1', [item.product_id, item.quantity]);
          }
        }
        await client.query(
          `insert into inventory_history(product_id,sku,action,details)
           select product_id, sku, 'order_deleted', jsonb_build_object(
             'order', jsonb_build_object(
               'id', $1::bigint,
               'orderNumber', $2::text,
               'customerName', $3::text,
               'status', $4::text,
               'total', $5::numeric,
               'createdAt', $6::timestamptz,
               'deletedAt', now(),
               'deletedByUserId', $7::text,
               'timezone', 'America/Guatemala'
             ),
             'items', $8::jsonb
           )
           from order_items where order_id=$1`,
          [
            order.id,
            order.order_number,
            order.customer_name,
            order.status,
            order.total,
            order.created_at,
            String(session.sub),
            JSON.stringify(items.map(item => ({ sku: item.sku, productName: item.product_name, quantity: item.quantity, unitPrice: item.unit_price, unitCost: item.unit_cost, subtotal: item.subtotal })))
          ]
        );
        await client.query('delete from order_items where order_id=$1', [id]);
        await client.query('delete from orders where id=$1', [id]);
        await client.query('commit');
        return response.status(200).json({ deleted: true, id });
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (request.method === 'GET') return response.status(200).json(await orderResponse(id));
    return response.status(405).json({ error: 'Método no permitido.' });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: error.message || 'No fue posible procesar la solicitud.' });
  }
};

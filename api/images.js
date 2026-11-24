const { pool, ensureDatabase } = require('../lib/database');

// Sirve una foto de producto por su id. Las fotos se guardan en la base como data URL;
// aquí se convierten a binario y se marcan como inmutables para que el CDN de Vercel
// y el navegador las guarden. Cada vez que se guarda un producto sus fotos reciben ids
// nuevos, así que una URL nunca cambia de contenido.
const CACHE_FOREVER = 'public, max-age=31536000, s-maxage=31536000, immutable';

module.exports = async function handler(request, response) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return response.status(405).json({ error: 'Método no permitido.' });
    const id = Number(String(request.query.route || request.query.id || '').replace(/^\/+|\/+$/g, ''));
    if (!Number.isSafeInteger(id) || id <= 0) return response.status(404).json({ error: 'Imagen no encontrada.' });

    await ensureDatabase();
    const { rows: [image] } = await pool.query('select image_url from product_images where id=$1', [id]);
    if (!image) return response.status(404).json({ error: 'Imagen no encontrada.' });

    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(image.image_url);
    if (!match) {
      if (/^https?:\/\//i.test(image.image_url)) {
        response.setHeader('Cache-Control', CACHE_FOREVER);
        return response.redirect(302, image.image_url);
      }
      return response.status(404).json({ error: 'Imagen no encontrada.' });
    }

    const body = Buffer.from(match[2], 'base64');
    response.setHeader('Content-Type', match[1].toLowerCase() === 'image/svg+xml' ? 'image/svg+xml' : match[1].toLowerCase());
    response.setHeader('Content-Length', String(body.length));
    response.setHeader('Cache-Control', CACHE_FOREVER);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') return response.status(200).end();
    return response.status(200).end(body);
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: 'No fue posible cargar la imagen.' });
  }
};

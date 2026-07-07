const { pool, ensureDatabase, defaultStorefrontSettings } = require('../lib/database');
const { sessionFromRequest } = require('../lib/security');

function sanitizedSettings(input = {}) {
  return {
    eyebrow: String(input.eyebrow || defaultStorefrontSettings.eyebrow).trim().slice(0, 60) || defaultStorefrontSettings.eyebrow,
    title: String(input.title || defaultStorefrontSettings.title).trim().slice(0, 140) || defaultStorefrontSettings.title,
    description: String(input.description || defaultStorefrontSettings.description).trim().slice(0, 320) || defaultStorefrontSettings.description,
    primaryCtaLabel: String(input.primaryCtaLabel || defaultStorefrontSettings.primaryCtaLabel).trim().slice(0, 40) || defaultStorefrontSettings.primaryCtaLabel
  };
}

function requireSession(request, response) {
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

    if (request.method === 'GET') {
      const { rows: [row] } = await pool.query('select storefront_banner from site_settings where id=1');
      return response.status(200).json(sanitizedSettings(row?.storefront_banner || {}));
    }

    if (request.method === 'PATCH') {
      const session = requireSession(request, response);
      if (!session) return;
      const payload = sanitizedSettings(request.body || {});
      const { rows: [row] } = await pool.query(
        `insert into site_settings (id, storefront_banner, updated_at)
         values (1, $1::jsonb, now())
         on conflict (id) do update
         set storefront_banner = excluded.storefront_banner,
             updated_at = now()
         returning storefront_banner`,
        [JSON.stringify(payload)]
      );
      return response.status(200).json(sanitizedSettings(row.storefront_banner || {}));
    }

    return response.status(405).json({ error: 'Metodo no permitido.' });
  } catch (error) {
    console.error(error);
    return response.status(500).json({ error: 'No fue posible guardar la configuracion.' });
  }
};

const axios = require('axios');
const crypto = require('crypto');

const VINTED_BASE = 'https://pro.svc.vinted.com';

function vintedHeaders(method, path, body = '') {
  const [accessKey, signingKey] = process.env.VINTED_ACCESS_TOKEN.split(',');
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${method}.${path}.${accessKey}.${body}`;
  const hmac = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
  return {
    'X-Vpi-Access-Key': accessKey,
    'X-Vpi-Hmac-Sha256': `t=${ts},v1=${hmac}`,
    'Content-Type': 'application/json',
  };
}

async function deleteVintedItem(uuid) {
  const body = JSON.stringify({ item_uuids: [uuid] });
  const path = '/api/v1/items';
  const headers = vintedHeaders('DELETE', path, body);
  await axios.delete(`${VINTED_BASE}${path}`, { headers, data: body });
}

// Vente Shopify = suppression de l'annonce sur Vinted
module.exports = async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).end();

  const order = req.body;
  res.status(200).json({ ok: true }); // Repondre a Shopify immediatement

  for (const lineItem of order.line_items || []) {
    const vintedUUID = lineItem.sku;
    if (!vintedUUID || vintedUUID.length < 10) continue;
    try {
      await deleteVintedItem(vintedUUID);
      console.log(`Annonce Vinted supprimee: ${vintedUUID}`);
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`Deja supprimee: ${vintedUUID}`);
      } else {
        console.error(`Erreur: ${vintedUUID}`, err.response?.data || err.message);
      }
    }
  }
};

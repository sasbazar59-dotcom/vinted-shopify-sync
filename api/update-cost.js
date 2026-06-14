const https = require('https');

function updateInventoryCost(inventoryItemId, cost) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ inventory_item: { cost: cost.toString() } });
    const options = {
      hostname: process.env.SHOPIFY_STORE_DOMAIN,
      path: `/admin/api/2024-01/inventory_items/${inventoryItemId}.json`,
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => resolve({ ok: r.statusCode < 300, status: r.statusCode }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = await readBody(req);
  const { secret, updates } = body;

  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  if (secret !== validPassword) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!Array.isArray(updates) || updates.length === 0) {
    res.status(400).json({ error: 'updates array required' });
    return;
  }

  const results = [];
  for (const { inventoryItemId, cost, label } of updates) {
    const result = await updateInventoryCost(inventoryItemId, cost);
    results.push({ inventoryItemId, cost, label: label || '', ...result });
    // Pause 250ms pour respecter les rate limits Shopify
    await new Promise(r => setTimeout(r, 250));
  }

  const successCount = results.filter(r => r.ok).length;
  res.status(200).json({
    success: successCount,
    total: results.length,
    failed: results.length - successCount,
    results,
  });
};

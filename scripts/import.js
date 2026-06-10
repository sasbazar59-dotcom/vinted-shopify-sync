require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const VINTED_BASE = 'https://pro.svc.vinted.com';
const SHOPIFY_BASE = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`;
const SHOPIFY_HEADERS = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  'Content-Type': 'application/json',
};

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

async function fetchVintedItems() {
  const all = [];
  let page = 1;
  while (true) {
    const path = `/api/v1/items?page=${page}&per_page=100`;
    const res = await axios.get(`${VINTED_BASE}${path}`, { headers: vintedHeaders('GET', path) });
    const items = res.data.items || [];
    all.push(...items);
    console.log(`  Page ${page}: ${items.length} articles`);
    if (items.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 400));
  }
  return all;
}

async function getLocationId() {
  const res = await axios.get(`${SHOPIFY_BASE}/locations.json`, { headers: SHOPIFY_HEADERS });
  return res.data.locations[0].id;
}

async function createProduct(item, locationId) {
  const price = item.price?.amount ?? item.price ?? '0';
  const photos = item.photos || item.images || [];
  const images = photos.map(p => ({ src: p.full_size_url || p.url || p }));

  const res = await axios.post(`${SHOPIFY_BASE}/products.json`, {
    product: {
      title: item.title || 'Article',
      body_html: item.description || '',
      status: 'active',
      variants: [{
        price: String(price),
        sku: item.uuid,
        inventory_management: 'shopify',
        fulfillment_service: 'manual',
      }],
      images,
    },
  }, { headers: SHOPIFY_HEADERS });

  const product = res.data.product;
  await axios.post(`${SHOPIFY_BASE}/inventory_levels/set.json`, {
    inventory_item_id: product.variants[0].inventory_item_id,
    location_id: locationId,
    available: 1,
  }, { headers: SHOPIFY_HEADERS });

  return product;
}

async function main() {
  console.log('=== Import Vinted -> Shopify ===');
  const required = ['VINTED_ACCESS_TOKEN', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'];
  for (const k of required) {
    if (!process.env[k]) { console.error('Variable manquante: ' + k); process.exit(1); }
  }

  console.log('Recuperation des articles Vinted...');
  const items = await fetchVintedItems();
  console.log(`${items.length} articles trouves\n`);

  const locationId = await getLocationId();
  let ok = 0, err = 0;

  for (const item of items) {
    try {
      await createProduct(item, locationId);
      console.log(`  OK: ${item.title}`);
      ok++;
    } catch (e) {
      console.error(`  ERR: ${item.title} - ${JSON.stringify(e.response?.data?.errors || e.message)}`);
      err++;
    }
    await new Promise(r => setTimeout(r, 700));
  }

  console.log(`\nTermine! OK: ${ok} | Erreurs: ${err}`);
  console.log('Prochaine etape: npm run register-webhooks');
}

main().catch(e => { console.error(e.message); process.exit(1); });

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

async function registerVintedWebhook() {
  const url = `${process.env.VERCEL_URL}/api/webhook-vinted?secret=${process.env.WEBHOOK_SECRET}`;
  const body = JSON.stringify({ url, event_types: ['ITEM_SOLD', 'ITEM_UPDATED'] });
  const path = '/api/v1/webhooks';
  await axios.post(`${VINTED_BASE}${path}`, body, { headers: vintedHeaders('POST', path, body) });
  console.log('OK: Webhook Vinted enregistre');
  console.log('   URL: ' + url);
}

async function registerShopifyWebhook() {
  const url = `${process.env.VERCEL_URL}/api/webhook-shopify?secret=${process.env.WEBHOOK_SECRET}`;
  await axios.post(`${SHOPIFY_BASE}/webhooks.json`, {
    webhook: { topic: 'orders/create', address: url, format: 'json' }
  }, { headers: SHOPIFY_HEADERS });
  console.log('OK: Webhook Shopify enregistre');
  console.log('   URL: ' + url);
}

async function main() {
  console.log('=== Enregistrement des webhooks ===');
  const required = ['VINTED_ACCESS_TOKEN', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ACCESS_TOKEN', 'VERCEL_URL', 'WEBHOOK_SECRET'];
  for (const k of required) {
    if (!process.env[k]) { console.error('Variable manquante: ' + k); process.exit(1); }
  }

  try { await registerVintedWebhook(); }
  catch (e) {
    const msg = JSON.stringify(e.response?.data || e.message);
    console.error('ERR Vinted:', msg);
  }

  try { await registerShopifyWebhook(); }
  catch (e) {
    const msg = JSON.stringify(e.response?.data || e.message);
    if (msg.includes('already')) console.log('INFO: Webhook Shopify deja enregistre');
    else console.error('ERR Shopify:', msg);
  }

  console.log('\nTermine ! La synchronisation est active.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

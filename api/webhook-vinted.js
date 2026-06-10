const axios = require('axios');

const SHOPIFY_BASE = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`;
const SHOPIFY_HEADERS = {
  'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  'Content-Type': 'application/json',
};

async function findVariantBySKU(sku) {
  const query = `{ productVariants(first: 1, query: "sku:${sku}") { edges { node { legacyResourceId inventoryItem { legacyResourceId } } } } }`;
  const res = await axios.post(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`,
    { query },
    { headers: SHOPIFY_HEADERS }
  );
  const edges = res.data.data?.productVariants?.edges || [];
  if (edges.length === 0) return null;
  return {
    variantId: edges[0].node.legacyResourceId,
    inventoryItemId: edges[0].node.inventoryItem.legacyResourceId,
  };
}

async function setStockToZero(inventoryItemId) {
  const locRes = await axios.get(`${SHOPIFY_BASE}/locations.json`, { headers: SHOPIFY_HEADERS });
  const locationId = locRes.data.locations[0].id;
  await axios.post(
    `${SHOPIFY_BASE}/inventory_levels/set.json`,
    { inventory_item_id: parseInt(inventoryItemId), location_id: locationId, available: 0 },
    { headers: SHOPIFY_HEADERS }
  );
}

async function updatePrice(variantId, newPrice) {
  await axios.put(
    `${SHOPIFY_BASE}/variants/${variantId}.json`,
    { variant: { id: parseInt(variantId), price: String(newPrice) } },
    { headers: SHOPIFY_HEADERS }
  );
}

// Vente Vinted = stock a 0 sur Shopify
// Modif Vinted = prix mis a jour sur Shopify (JAMAIS les images)
module.exports = async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).end();
  const { event_type, item } = req.body;
  if (!item?.uuid) return res.status(400).json({ error: 'Missing item.uuid' });
  try {
    if (event_type === 'ITEM_SOLD') {
      const variant = await findVariantBySKU(item.uuid);
      if (!variant) return res.status(200).json({ ok: true });
      await setStockToZero(variant.inventoryItemId);
    } else if (event_type === 'ITEM_UPDATED') {
      const newPrice = item.price?.amount ?? item.price;
      if (!newPrice) return res.status(200).json({ ok: true });
      const variant = await findVariantBySKU(item.uuid);
      if (!variant) return res.status(200).json({ ok: true });
      await updatePrice(variant.variantId, newPrice);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Internal error' });
  }
};

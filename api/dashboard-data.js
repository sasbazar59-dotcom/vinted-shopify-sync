// =============================================================================
// DASHBOARD DATA API
// =============================================================================
// GET  /api/dashboard-data?secret=MOT_DE_PASSE  â donnÃ©es stock + ventes
// PUT  /api/dashboard-data?secret=MOT_DE_PASSE  â met Ã  jour un prix d'achat
// =============================================================================

const https = require('https');

function shopifyRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: process.env.SHOPIFY_STORE_DOMAIN,
      path: `/admin/api/2024-01${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const { secret } = req.query;
  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  if (!secret || secret !== validPassword) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // ââ PUT : mise Ã  jour prix d'achat ââââââââââââââââââââââââââââââââââ
  if (req.method === 'PUT') {
    const { inventoryItemId, cost } = await readBody(req);
    if (!inventoryItemId || cost === undefined) {
      return res.status(400).json({ error: 'ParamÃ¨tres manquants' });
    }
    try {
      const result = await shopifyRequest(
        'PUT',
        `/inventory_items/${inventoryItemId}.json`,
        { inventory_item: { id: inventoryItemId, cost: String(parseFloat(cost).toFixed(2)) } }
      );
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ââ GET : toutes les donnÃ©es ââââââââââââââââââââââââââââââââââââââââ
  try {
    // 1. Produits
    const { products = [] } = await shopifyRequest('GET', '/products.json?limit=250');

    // 2. Prix d'achat (inventory items) â par batch de 100
    const allVariants = products.flatMap((p) =>
      p.variants.map((v) => ({
        ...v,
        productId: p.id,
        productTitle: p.title,
        productImage: p.images?.[0]?.src || null,
      }))
    );
    const invIds = allVariants.map((v) => v.inventory_item_id);
    const costMap = {};
    for (let i = 0; i < invIds.length; i += 100) {
      const chunk = invIds.slice(i, i + 100);
      const { inventory_items = [] } = await shopifyRequest(
        'GET',
        `/inventory_items.json?ids=${chunk.join(',')}&limit=100`
      );
      for (const item of inventory_items) {
        costMap[item.id] = item.cost != null ? parseFloat(item.cost) : null;
      }
    }

    // 3. Commandes (90 derniers jours, payÃ©es)
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { orders = [] } = await shopifyRequest(
      'GET',
      `/orders.json?limit=250&status=any&created_at_min=${since}&financial_status=paid`
    );

    // ââ Calculs stock ââ
    let totalStockValue = 0;
    let totalCostValue = 0;
    let costRenseignes = 0;

    const stock = allVariants.map((v) => {
      const qty = v.inventory_quantity || 0;
      const price = parseFloat(v.price) || 0;
      const cost = costMap[v.inventory_item_id];

      totalStockValue += price * qty;
      if (cost != null) {
        totalCostValue += cost * qty;
        costRenseignes++;
      }

      return {
        productId: v.productId,
        inventoryItemId: v.inventory_item_id,
        title: v.productTitle,
        variant: v.title !== 'Default Title' ? v.title : null,
        sku: v.sku || '',
        price,
        cost,
        stock: qty,
        image: v.productImage,
        totalValue: parseFloat((price * qty).toFixed(2)),
        totalCost: cost != null ? parseFloat((cost * qty).toFixed(2)) : null,
        marginPct: cost != null && price > 0 ? parseFloat(((price - cost) / price * 100).toFixed(1)) : null,
      };
    }).sort((a, b) => b.totalValue - a.totalValue);

    // ââ Calculs ventes ââ
    const salesByMonth = {};
    let totalRevenue = 0;
    const soldMap = {};

    for (const order of orders) {
      const month = order.created_at.substring(0, 7);
      const amount = parseFloat(order.total_price);
      salesByMonth[month] = (salesByMonth[month] || 0) + amount;
      totalRevenue += amount;
      for (const item of order.line_items || []) {
        soldMap[item.title] = (soldMap[item.title] || 0) + item.quantity;
      }
    }

    // Graphique : 6 derniers mois
    const chart = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().substring(0, 7);
      chart.push({ month: key, revenue: parseFloat((salesByMonth[key] || 0).toFixed(2)) });
    }

    const topSold = Object.entries(soldMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map(([title, qty]) => ({ title, qty }));

    const potentialMargin = costRenseignes > 0 ? parseFloat((totalStockValue - totalCostValue).toFixed(2)) : null;

    return res.status(200).json({
      summary: {
        totalProducts: products.length,
        inStock: stock.filter((s) => s.stock > 0).length,
        outOfStock: stock.filter((s) => s.stock === 0).length,
        totalStockValue: parseFloat(totalStockValue.toFixed(2)),
        totalCostValue: costRenseignes > 0 ? parseFloat(totalCostValue.toFixed(2)) : null,
        potentialMargin,
        revenue90d: parseFloat(totalRevenue.toFixed(2)),
        orders90d: orders.length,
        costCoverage: `${costRenseignes}/${allVariants.length}`,
      },
      stock,
      chart,
      topSold,
      recentOrders: orders.slice(0, 20).map((o) => ({
        name: o.name || `#${o.id}`,
        date: o.created_at,
        total: parseFloat(o.total_price),
        items: o.line_items?.reduce((s, i) => s + i.quantity, 0) || 0,
        products: o.line_items?.map((i) => i.title).slice(0, 2).join(', ') || '',
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};


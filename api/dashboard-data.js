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

  const { secret } = req.query;
  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  if (!secret || secret !== validPassword) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  // PUT : mise a jour prix d'achat
  if (req.method === 'PUT') {
    const { inventoryItemId, cost } = await readBody(req);
    if (!inventoryItemId || cost === undefined) {
      return res.status(400).json({ error: 'Parametres manquants' });
    }
    try {
      const result = await shopifyRequest('PUT',
        `/inventory_items/${inventoryItemId}.json`,
        { inventory_item: { id: inventoryItemId, cost: String(parseFloat(cost).toFixed(2)) } }
      );
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET
  try {
    // Parametres de periode
    const days       = parseInt(req.query.days) || 90;
    const fromParam  = req.query.from || null;
    const toParam    = req.query.to   || null;
    const ordersOnly = req.query.ordersOnly === 'true';

    const since = fromParam
      ? new Date(fromParam).toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const untilParam = toParam
      ? `&created_at_max=${new Date(toParam + 'T23:59:59').toISOString()}`
      : '';

    // Commandes de la periode
    const { orders = [] } = await shopifyRequest('GET',
      `/orders.json?limit=250&status=any&created_at_min=${since}${untilParam}&financial_status=paid`);

    const periodRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price), 0);
    const periodOrders  = orders.length;

    // Commandes detaillees (pour onglet Ventes & CSV)
    const detailedOrders = orders.map((o) => ({
      name:     o.name || ('#' + o.id),
      date:     o.created_at,
      total:    parseFloat(o.total_price),
      items:    (o.line_items || []).reduce((s, li) => s + li.quantity, 0),
      products: (o.line_items || []).map((li) => {
        const v = li.variant_title && li.variant_title !== 'Default Title' ? ' (' + li.variant_title + ')' : '';
        return li.title + v + ' x' + li.quantity;
      }).join(', '),
      lineItems: (o.line_items || []).map((li) => ({
        title:   li.title,
        variant: li.variant_title && li.variant_title !== 'Default Title' ? li.variant_title : null,
        qty:     li.quantity,
        price:   parseFloat(li.price),
      })),
    }));

    // Mode leger : uniquement commandes (pas de stock/graphiques)
    if (ordersOnly) {
      return res.status(200).json({
        summary: {
          periodRevenue: parseFloat(periodRevenue.toFixed(2)),
          periodOrders,
          periodDays:   days,
          periodFrom:   fromParam,
          periodTo:     toParam,
        },
        recentOrders: detailedOrders,
      });
    }

    // Mode complet : stock + graphiques
    const { products = [] } = await shopifyRequest('GET', '/products.json?limit=250');
    const allVariants = products.flatMap((p) =>
      p.variants.map((v) => ({
        ...v,
        productId:    p.id,
        productTitle: p.title,
        productImage: p.images?.[0]?.src || null,
      }))
    );

    const invIds  = allVariants.map((v) => v.inventory_item_id);
    const costMap = {};
    for (let i = 0; i < invIds.length; i += 100) {
      const chunk = invIds.slice(i, i + 100);
      const { inventory_items = [] } = await shopifyRequest('GET',
        `/inventory_items.json?ids=${chunk.join(',')}&limit=100`);
      for (const item of inventory_items) {
        costMap[item.id] = item.cost != null ? parseFloat(item.cost) : null;
      }
    }

    let totalStockValue = 0, totalCostValue = 0, costRenseignes = 0;
    const stock = allVariants.map((v) => {
      const qty   = v.inventory_quantity || 0;
      const price = parseFloat(v.price) || 0;
      const cost  = costMap[v.inventory_item_id];
      totalStockValue += price * qty;
      if (cost != null) { totalCostValue += cost * qty; costRenseignes++; }
      return {
        productId:       v.productId,
        inventoryItemId: v.inventory_item_id,
        title:           v.productTitle,
        variant:         v.title !== 'Default Title' ? v.title : null,
        sku:             v.sku || '',
        price,
        cost,
        stock:           qty,
        image:           v.productImage,
        totalValue:      parseFloat((price * qty).toFixed(2)),
        totalCost:       cost != null ? parseFloat((cost * qty).toFixed(2)) : null,
        marginPct:       cost != null && price > 0
          ? parseFloat(((price - cost) / price * 100).toFixed(1)) : null,
      };
    }).sort((a, b) => b.totalValue - a.totalValue);

    // Graphique 6 mois (toujours fixe)
    const salesByMonth = {};
    const soldMap = {};
    let chartOrders = orders;

    const since6m = (() => {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 5);
      return d.toISOString();
    })();

    if (fromParam || days < 180) {
      const { orders: o6m = [] } = await shopifyRequest('GET',
        `/orders.json?limit=250&status=any&created_at_min=${since6m}&financial_status=paid`);
      chartOrders = o6m;
    }
    for (const o of chartOrders) {
      const month  = o.created_at.substring(0, 7);
      salesByMonth[month] = (salesByMonth[month] || 0) + parseFloat(o.total_price);
      for (const li of (o.line_items || [])) {
        const key = li.title;
        if (!soldMap[key]) soldMap[key] = { title: li.title, qty: 0 };
        soldMap[key].qty += li.quantity;
      }
    }

    const chart = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = d.toISOString().substring(0, 7);
      chart.push({ month: key, revenue: parseFloat((salesByMonth[key] || 0).toFixed(2)) });
    }

    const topSold = Object.values(soldMap)
      .sort((a, b) => b.qty - a.qty).slice(0, 7);

    const potentialMargin = costRenseignes > 0
      ? parseFloat((totalStockValue - totalCostValue).toFixed(2)) : null;

    return res.status(200).json({
      summary: {
        totalProducts:   products.length,
        inStock:         stock.filter((s) => s.stock > 0).length,
        outOfStock:      stock.filter((s) => s.stock === 0).length,
        totalStockValue: parseFloat(totalStockValue.toFixed(2)),
        totalCostValue:  costRenseignes > 0 ? parseFloat(totalCostValue.toFixed(2)) : null,
        potentialMargin,
        revenue90d:      parseFloat(periodRevenue.toFixed(2)),
        orders90d:       periodOrders,
        periodRevenue:   parseFloat(periodRevenue.toFixed(2)),
        periodOrders,
        periodDays:      days,
        periodFrom:      fromParam,
        periodTo:        toParam,
        costCoverage:    costRenseignes + '/' + allVariants.length,
      },
      stock,
      chart,
      topSold,
      recentOrders: detailedOrders.slice(0, 20),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};

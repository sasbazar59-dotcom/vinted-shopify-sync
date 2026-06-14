const https = require('https');

function vintedGet(path, token) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.vinted.fr',
      path: '/api/v2' + path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer': 'https://www.vinted.fr/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode }); }
        catch (e) { resolve({ data: { raw: data.substring(0, 300) }, status: r.statusCode }); }
      });
    });
    req.on('error', (e) => resolve({ data: { error: e.message }, status: 0 }));
    req.end();
  });
}

function vintedPost(path, body, token) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'www.vinted.fr',
      path: '/api/v2' + path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Referer': 'https://www.vinted.fr/',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode }); }
        catch (e) { resolve({ data: { raw: data.substring(0, 300) }, status: r.statusCode }); }
      });
    });
    req.on('error', (e) => resolve({ data: { error: e.message }, status: 0 }));
    req.write(bodyStr);
    req.end();
  });
}

function shopifyGet(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: process.env.SHOPIFY_STORE_DOMAIN,
      path: `/admin/api/2024-01${path}`,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

function shopifyPut(path, body) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: process.env.SHOPIFY_STORE_DOMAIN,
      path: `/admin/api/2024-01${path}`,
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

function shopifyPost(path, body) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: process.env.SHOPIFY_STORE_DOMAIN,
      path: `/admin/api/2024-01${path}`,
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(bodyStr);
    req.end();
  });
}

async function getWatcherLog() {
  const res = await shopifyGet('/metafields.json?namespace=vinted_relances&key=watcher_log&owner_resource=shop');
  const meta = res.metafields?.[0];
  if (!meta) return { metafieldId: null, log: {} };
  try {
    return { metafieldId: meta.id, log: JSON.parse(meta.value) };
  } catch (e) {
    return { metafieldId: meta.id, log: {} };
  }
}

async function saveWatcherLog(metafieldId, log) {
  const value = JSON.stringify(log);
  if (metafieldId) {
    return shopifyPut(`/metafields/${metafieldId}.json`, {
      metafield: { id: metafieldId, value, type: 'json' }
    });
  } else {
    return shopifyPost('/metafields.json', {
      metafield: { namespace: 'vinted_relances', key: 'watcher_log', value, type: 'json', owner_resource: 'shop' }
    });
  }
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { secret, action } = req.query;
  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  if (!secret || secret !== validPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.VINTED_ACCESS_TOKEN;
  const userId = process.env.VINTED_USER_ID || '3136330750';

  // Vérifier si token est expiré
  let tokenExpired = false;
  let tokenExpiresAt = null;
  if (token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      tokenExpiresAt = payload.exp * 1000;
      tokenExpired = Date.now() > tokenExpiresAt;
    } catch (e) {}
  }

  if (action === 'status') {
    return res.status(200).json({
      hasToken: !!token,
      tokenExpired,
      tokenExpiresAt,
      userId,
    });
  }

  if (!token || tokenExpired) {
    return res.status(401).json({ error: 'VINTED_ACCESS_TOKEN manquant ou expiré', tokenExpired, tokenExpiresAt });
  }

  if (req.method === 'GET') {
    if (action === 'items') {
      const result = await vintedGet(`/items?user_id=${userId}&page=1&per_page=100&order=newest_first`, token);
      return res.status(result.status).json(result.data);
    }

    if (action === 'watchers') {
      const { item_id } = req.query;
      if (!item_id) return res.status(400).json({ error: 'item_id requis' });
      const result = await vintedGet(`/items/${item_id}/item_watchers?page=1&per_page=50`, token);
      return res.status(result.status).json(result.data);
    }

    if (action === 'watcher_log') {
      const { log, metafieldId } = await getWatcherLog();
      return res.status(200).json({ log, metafieldId });
    }
  }

  if (req.method === 'POST') {
    const body = await readBody(req);

    if (action === 'message') {
      const { recipient_id, item_id, message } = body;
      if (!recipient_id || !message) return res.status(400).json({ error: 'recipient_id et message requis' });

      // Créer ou récupérer la conversation
      const convResult = await vintedPost('/conversations', {
        user_id: parseInt(recipient_id),
        item_id: item_id ? parseInt(item_id) : undefined,
      }, token);

      if (!convResult.data.conversation?.id) {
        return res.status(convResult.status).json({ error: 'Impossible de créer la conversation', detail: convResult.data });
      }
      const convId = convResult.data.conversation.id;

      // Envoyer le message
      const msgResult = await vintedPost(`/conversations/${convId}/messages`, {
        body: message,
        entity_type: 'msg_text',
      }, token);

      return res.status(msgResult.status).json({ ok: msgResult.status < 300, ...msgResult.data });
    }

    if (action === 'update_log') {
      const { log } = body;
      if (!log) return res.status(400).json({ error: 'log requis' });
      const { metafieldId } = await getWatcherLog();
      const result = await saveWatcherLog(metafieldId, log);
      return res.status(200).json({ ok: true, result });
    }
  }

  return res.status(400).json({ error: 'Action inconnue: ' + action });
};

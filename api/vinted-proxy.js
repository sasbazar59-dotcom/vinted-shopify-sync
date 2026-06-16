const https = require('https');

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Token auto-refresh via _vinted_fr_session ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ

// Lit le token sauvegardÃÂÃÂ© dans Shopify (mis ÃÂÃÂ  jour via bookmarklet ou saisie manuelle)
async function getStoredToken() {
  try {
    const res = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=access_token&owner_resource=shop');
    return res.metafields?.[0]?.value || null;
  } catch(e) { return null; }
}

async function getOrRefreshToken() {
  // 1. Token sauvegardÃÂÃÂ© dans Shopify (mis ÃÂÃÂ  jour via bookmarklet ou saisie manuelle)
  const storedToken = await getStoredToken();
  if (storedToken) {
    try {
      const payload = JSON.parse(Buffer.from(storedToken.split('.')[1], 'base64').toString());
      if (Date.now() < payload.exp * 1000 - 60000) {
        return { token: storedToken, refreshed: false, expiresAt: payload.exp * 1000, source: 'shopify' };
      }
    } catch(e) {}
  }

  // 2. Token dans les variables d'environnement Vercel
  const currentToken = process.env.VINTED_ACCESS_TOKEN;
  const sessionCookie = process.env.VINTED_SESSION_COOKIE;

  if (currentToken) {
    try {
      const payload = JSON.parse(Buffer.from(currentToken.split('.')[1], 'base64').toString());
      if (Date.now() < payload.exp * 1000 - 60000) {
        return { token: currentToken, refreshed: false, expiresAt: payload.exp * 1000, source: 'env' };
      }
    } catch (e) {}
  }

  // Token expirÃÂÃÂ© ou absent ÃÂ¢ÃÂÃÂ renouveler via la session cookie
  if (!sessionCookie) {
    return { token: currentToken, refreshed: false, error: 'VINTED_SESSION_COOKIE manquant' };
  }

  const res = await new Promise((resolve) => {
    const options = {
      hostname: 'www.vinted.fr',
      path: '/api/v2/users/current_user',
      method: 'GET',
      headers: {
        'Cookie': `_vinted_fr_session=${sessionCookie}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Referer': 'https://www.vinted.fr/',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      const cookies = r.headers['set-cookie'] || [];
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode, cookies }); }
        catch (e) { resolve({ data: {}, status: r.statusCode, cookies }); }
      });
    });
    req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ data: {}, status: 0, cookies: [], timedOut: e.message === 'timeout' }));
    req.end();
  });

  let newToken = null;
  for (const cookie of res.cookies) {
    const match = cookie.match(/access_token=([^;]+)/);
    if (match && match[1] && match[1] !== 'deleted') {
      newToken = decodeURIComponent(match[1]);
      break;
    }
  }
  if (!newToken && res.data?.user?.access_token) newToken = res.data.user.access_token;
  if (!newToken && res.data?.access_token) newToken = res.data.access_token;

  if (newToken) {
    await saveTokenToMetafields(newToken);
    let expiresAt = null;
    try {
      const p = JSON.parse(Buffer.from(newToken.split('.')[1], 'base64').toString());
      expiresAt = p.exp * 1000;
    } catch (e) {}
    return { token: newToken, refreshed: true, expiresAt };
  }

  return {
    token: currentToken,
    refreshed: false,
    error: 'Impossible de renouveler le token',
    _debug: { status: res.status, cookies: res.cookies.length, dataKeys: Object.keys(res.data || {}) },
  };
}

async function saveTokenToMetafields(token) {
  const existing = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=access_token&owner_resource=shop');
  const meta = existing.metafields?.[0];
  if (meta) {
    await shopifyReq('PUT', `/metafields/${meta.id}.json`, {
      metafield: { id: meta.id, value: token, type: 'single_line_text_field' }
    });
  } else {
    await shopifyReq('POST', '/metafields.json', {
      metafield: { namespace: 'vinted_relances', key: 'access_token', value: token, type: 'single_line_text_field', owner_resource: 'shop' }
    });
  }
}

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ HTTP helpers ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ



async function getStoredSessionCookie() {
  try {
    const res = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=session_cookie&owner_resource=shop');
    return res.metafields?.[0]?.value || null;
  } catch(e) { return null; }
}

async function saveSessionCookieToMetafields(cookie) {
  try {
    const existing = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=session_cookie&owner_resource=shop');
    const meta = existing.metafields?.[0];
    if (meta) {
      await shopifyReq('PUT', `/metafields/${meta.id}.json`, { metafield: { id: meta.id, value: cookie, type: 'single_line_text_field' } });
    } else {
      await shopifyReq('POST', '/metafields.json', { metafield: { namespace: 'vinted_relances', key: 'session_cookie', value: cookie, type: 'single_line_text_field', owner_resource: 'shop' } });
    }
  } catch(e) {}
}
async function forceRefreshToken() {
  const sessionCookie = process.env.VINTED_SESSION_COOKIE;
  if (!sessionCookie) return { token: null, error: 'No session cookie' };
  const res = await new Promise((resolve) => {
    const options = {
      hostname: 'www.vinted.fr',
      path: '/api/v2/users/current_user',
      method: 'GET',
      headers: {
        'Cookie': `_vinted_fr_session=${sessionCookie}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Referer': 'https://www.vinted.fr/',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      const cookies = r.headers['set-cookie'] || [];
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode, cookies }); }
        catch (e) { resolve({ data: {}, status: r.statusCode, cookies }); }
      });
    });
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ data: {}, status: 0, cookies: [] }));
    req.end();
  });
  let newToken = null;
  for (const cookie of res.cookies) {
    const match = cookie.match(/access_token=([^;]+)/);
    if (match && match[1] && match[1] !== 'deleted') { newToken = decodeURIComponent(match[1]); break; }
  }
  if (!newToken && res.data?.user?.access_token) newToken = res.data.user.access_token;
  if (!newToken && res.data?.access_token) newToken = res.data.access_token;
  if (newToken) { await saveTokenToMetafields(newToken); return { token: newToken }; }
  return { token: null, error: 'Session cookie expired' };
}

function vintedGet(path, token) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'www.vinted.fr',
      path: '/api/v2' + path,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        ...(process.env.VINTED_SESSION_COOKIE ? { 'Cookie': `_vinted_fr_session=${process.env.VINTED_SESSION_COOKIE}` } : {}),
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
        catch (e) { resolve({ data: { raw: data.substring(0, 2000) }, status: r.statusCode }); }
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

function shopifyReq(method, path, body) {
  return new Promise((resolve) => {
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
        catch (e) { resolve({ error: data }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getWatcherLog() {
  const res = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=watcher_log&owner_resource=shop');
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
    return shopifyReq('PUT', `/metafields/${metafieldId}.json`, {
      metafield: { id: metafieldId, value, type: 'json' }
    });
  }
  return shopifyReq('POST', '/metafields.json', {
    metafield: { namespace: 'vinted_relances', key: 'watcher_log', value, type: 'json', owner_resource: 'shop' }
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

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Main handler ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ

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

  const userId = process.env.VINTED_USER_ID || '3136330750';

  // Action status : info sans nÃÂÃÂ©cessiter un token valide
  if (action === 'status') {
    const rawToken = process.env.VINTED_ACCESS_TOKEN;
    let tokenExpired = true;
    let tokenExpiresAt = null;
    if (rawToken) {
      try {
        const payload = JSON.parse(Buffer.from(rawToken.split('.')[1], 'base64').toString());
        tokenExpiresAt = payload.exp * 1000;
        tokenExpired = Date.now() > tokenExpiresAt;
      } catch (e) {}
    }
    const stored = await getStoredToken();
    let storedExpired = true;
    let storedExpiresAt = null;
    if (stored) {
      try {
        const p = JSON.parse(Buffer.from(stored.split('.')[1], 'base64').toString());
        storedExpiresAt = p.exp * 1000;
        storedExpired = Date.now() > storedExpiresAt;
      } catch(e) {}
    }
    const activeSource = (stored && !storedExpired) ? 'shopify' : (!tokenExpired ? 'env' : 'none');
    return res.status(200).json({
      hasToken: !!rawToken,
      tokenExpired,
      tokenExpiresAt,
      hasSessionCookie: !!process.env.VINTED_SESSION_COOKIE,
      userId,
      storedToken: !!stored,
      storedTokenExpired: storedExpired,
      storedTokenExpiresAt: storedExpiresAt,
      activeSource,
    });
  }

  // Action update_token : mise ÃÂÃÂ  jour du token depuis le bookmarklet ou la saisie manuelle
  if (action === 'update_token') {
    let newTok = null;
    if (req.method === 'POST') {
      const body = await readBody(req);
      newTok = body.token;
    } else {
      newTok = req.query.token;
    }
    if (!newTok) return res.status(400).json({ error: 'token requis' });
    await saveTokenToMetafields(newTok);
    return res.status(200).json({ ok: true, message: 'Token mis ÃÂÃÂ  jour avec succÃÂÃÂ¨s' });
  }

  // Pour toutes les autres actions, obtenir/renouveler le token automatiquement
  const { token, refreshed, error: tokenError } = await getOrRefreshToken();
  if (!token) {
    return res.status(401).json({ error: tokenError || 'Token Vinted indisponible' });
  }

  if (req.method === 'GET') {
    if (action === 'items') {
      let itemResult = await vintedGet(`/catalog/items?user_id=${userId}&page=1&per_page=100&order=newest_first`, token);
      if (itemResult.status === 401 || itemResult.data?.code === 100) {
        const forced = await forceRefreshToken();
        if (forced.token) {
          itemResult = await vintedGet(`/catalog/items?user_id=${userId}&page=1&per_page=100&order=newest_first`, forced.token);
          refreshed = true;
        }
      }
      return res.status(itemResult.status).json({ ...itemResult.data, _tokenRefreshed: refreshed });
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

      const convResult = await vintedPost('/conversations', {
        user_id: parseInt(recipient_id),
        item_id: item_id ? parseInt(item_id) : undefined,
      }, token);

      if (!convResult.data.conversation?.id) {
        return res.status(convResult.status).json({ error: 'Impossible de crÃÂÃÂ©er la conversation', detail: convResult.data });
      }
      const convId = convResult.data.conversation.id;

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

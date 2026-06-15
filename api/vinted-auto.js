/**
 * Endpoint cron : Relances automatiques Vinted
 * Tourne chaque jour à 9h (configurer dans vercel.json)
 * - Récupère/renouvelle automatiquement le token Vinted via _vinted_fr_session
 * - Envoie un message de relance après 3 jours d'attente
 * - Garde un log dans les métachamps Shopify
 */
const https = require('https');

const RELANCE_DAYS = 3;
const ITEMS_LIMIT = 50;

const MESSAGE_TEMPLATE = `Bonjour ! 😊

J'ai remarqué que vous avez mis mon article en favoris — il est encore disponible !

✨ N'hésitez pas si vous avez des questions, je réponds très rapidement.
📦 Envoi soigné et rapide, articles emballés avec soin.

À très bientôt !`;

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpReq(options, body) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (r) => {
      let data = '';
      const rawCookies = r.headers['set-cookie'] || [];
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode, cookies: rawCookies }); }
        catch (e) { resolve({ data: { raw: data.substring(0, 300) }, status: r.statusCode, cookies: rawCookies }); }
      });
    });
    req.on('error', (e) => resolve({ data: { error: e.message }, status: 0, cookies: [] }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function vintedGet(path, token) {
  return httpReq({
    hostname: 'www.vinted.fr',
    path: '/api/v2' + path,
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Referer': 'https://www.vinted.fr/',
    },
  });
}

function vintedPost(path, body, token) {
  return httpReq({
    hostname: 'www.vinted.fr',
    path: '/api/v2' + path,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.vinted.fr/',
    },
  }, body);
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

// ─── Token auto-refresh via _vinted_fr_session ───────────────────────────────

async function getOrRefreshToken() {
  const currentToken = process.env.VINTED_ACCESS_TOKEN;
  const sessionCookie = process.env.VINTED_SESSION_COOKIE;

  // Vérifier si token courant est encore valide
  if (currentToken) {
    try {
      const payload = JSON.parse(Buffer.from(currentToken.split('.')[1], 'base64').toString());
      if (Date.now() < payload.exp * 1000 - 60000) {
        return { token: currentToken, refreshed: false };
      }
    } catch (e) {}
  }

  // Token expiré ou absent — renouveler via la session cookie
  if (!sessionCookie) {
    return { token: null, error: 'VINTED_SESSION_COOKIE manquant' };
  }

  // Appeler Vinted avec le cookie de session pour obtenir un nouveau token
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
    req.on('error', (e) => resolve({ data: {}, status: 0, cookies: [] }));
    req.end();
  });

  // Chercher access_token dans les cookies Set-Cookie
  let newToken = null;
  for (const cookie of res.cookies) {
    const match = cookie.match(/access_token=([^;]+)/);
    if (match && match[1] && match[1] !== 'deleted') {
      newToken = decodeURIComponent(match[1]);
      break;
    }
  }

  // Ou dans le body de la réponse (Vinted encapsule dans user{})
  if (!newToken && res.data?.user?.access_token) newToken = res.data.user.access_token;
  if (!newToken && res.data?.access_token) newToken = res.data.access_token;

  if (newToken) {
    // Sauvegarder le nouveau token dans Shopify metafields pour réutilisation
    await saveTokenToMetafields(newToken);
    return { token: newToken, refreshed: true };
  }

  // Essayer un autre endpoint
  const res2 = await new Promise((resolve) => {
    const options = {
      hostname: 'www.vinted.fr',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Cookie': `_vinted_fr_session=${sessionCookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.vinted.fr/',
        'Content-Length': 0,
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
    req.on('error', (e) => resolve({ data: {}, status: 0, cookies: [] }));
    req.end();
  });

  if (res2.data?.access_token) {
    await saveTokenToMetafields(res2.data.access_token);
    return { token: res2.data.access_token, refreshed: true };
  }

  // Fallback : utiliser le token existant même s'il est expiré
  return {
    token: currentToken,
    error: 'Impossible de renouveler le token',
    refreshed: false,
    _debug: {
      cookieStatus: res.status,
      cookieCount: res.cookies.length,
      cookieDataKeys: Object.keys(res.data || {}),
      oauthStatus: res2.status,
      oauthDataKeys: Object.keys(res2.data || {}),
    },
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

// ─── Watcher log ─────────────────────────────────────────────────────────────

async function getWatcherLog() {
  const res = await shopifyReq('GET', '/metafields.json?namespace=vinted_relances&key=watcher_log&owner_resource=shop');
  const meta = res.metafields?.[0];
  if (!meta) return { metafieldId: null, log: {} };
  try { return { metafieldId: meta.id, log: JSON.parse(meta.value) }; }
  catch (e) { return { metafieldId: meta.id, log: {} }; }
}

async function saveWatcherLog(metafieldId, log) {
  const value = JSON.stringify(log);
  if (metafieldId) {
    return shopifyReq('PUT', `/metafields/${metafieldId}.json`, { metafield: { id: metafieldId, value, type: 'json' } });
  }
  return shopifyReq('POST', '/metafields.json', {
    metafield: { namespace: 'vinted_relances', key: 'watcher_log', value, type: 'json', owner_resource: 'shop' }
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  const { secret } = req.query;
  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = secret === validPassword;
  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = process.env.VINTED_USER_ID || '3136330750';

  // Obtenir/renouveler le token automatiquement
  const tokenResult = await getOrRefreshToken();
  const { token, refreshed, error: tokenError, _debug: tokenDebug } = tokenResult;
  if (!token) {
    return res.status(401).json({ error: tokenError || 'Token Vinted indisponible', tokenDebug });
  }

  const results = { sent: [], skipped: [], errors: [], newWatchers: 0, tokenRefreshed: refreshed, tokenError: tokenError || null, tokenDebug };
  const today = new Date().toISOString().slice(0, 10);

  const { metafieldId, log } = await getWatcherLog();

  const itemsRes = await vintedGet(`/items?user_id=${userId}&page=1&per_page=${ITEMS_LIMIT}&order=newest_first`, token);
  if (!itemsRes.data.items) {
    return res.status(500).json({ error: 'Impossible de récupérer les articles Vinted', detail: itemsRes.data, tokenRefreshed: refreshed, tokenError: tokenError || null, tokenDebug });
  }

  const items = itemsRes.data.items.filter(i => i.status === 'Active' || i.status === 1);

  for (const item of items) {
    const watchRes = await vintedGet(`/items/${item.id}/item_watchers?page=1&per_page=50`, token);
    const watchers = watchRes.data.item_watchers || [];

    for (const watcher of watchers) {
      const key = `${item.id}_${watcher.user?.id || watcher.id}`;
      const watcherId = watcher.user?.id || watcher.id;
      const watcherLogin = watcher.user?.login || 'inconnu';

      if (!log[key]) {
        log[key] = {
          first_seen: today,
          item_id: item.id,
          item_title: item.title,
          watcher_id: watcherId,
          watcher_login: watcherLogin,
          messaged: false,
          message_date: null,
        };
        results.newWatchers++;
      } else if (!log[key].messaged) {
        const firstSeen = new Date(log[key].first_seen);
        const daysPassed = Math.floor((Date.now() - firstSeen) / (1000 * 60 * 60 * 24));

        if (daysPassed >= RELANCE_DAYS) {
          const convRes = await vintedPost('/conversations', {
            user_id: parseInt(watcherId),
            item_id: parseInt(item.id),
          }, token);

          if (convRes.data.conversation?.id) {
            const convId = convRes.data.conversation.id;
            const msgRes = await vintedPost(`/conversations/${convId}/messages`, {
              body: MESSAGE_TEMPLATE,
              entity_type: 'msg_text',
            }, token);

            if (msgRes.status < 300) {
              log[key].messaged = true;
              log[key].message_date = today;
              results.sent.push({ item: item.title, watcher: watcherLogin, days: daysPassed });
            } else {
              results.errors.push({ item: item.title, watcher: watcherLogin, error: JSON.stringify(msgRes.data) });
            }
          } else {
            results.errors.push({ item: item.title, watcher: watcherLogin, error: 'Conversation non créée' });
          }
          await sleep(500);
        } else {
          results.skipped.push({ item: item.title, watcher: watcherLogin, days: daysPassed });
        }
      }
    }
    await sleep(200);
  }

  // Nettoyage 30 jours
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(log)) {
    if (log[key].first_seen < cutoff && log[key].messaged) delete log[key];
  }

  await saveWatcherLog(metafieldId, log);

  return res.status(200).json({
    ok: true,
    date: today,
    token_refreshed: refreshed,
    items_checked: items.length,
    new_watchers: results.newWatchers,
    messages_sent: results.sent.length,
    messages_skipped: results.skipped.length,
    errors: results.errors.length,
    details: results,
  });
};

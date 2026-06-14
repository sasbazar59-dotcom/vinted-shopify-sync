/**
 * Endpoint cron : Relances automatiques Vinted
 * Tourne chaque jour à 9h (configurer dans vercel.json)
 * - Récupère tous les articles et leurs observateurs (favoris)
 * - Envoie un message de relance après 3 jours d'attente
 * - Garde un log dans les métachamps Shopify
 */
const https = require('https');

const RELANCE_DAYS = 3;      // Délai avant d'envoyer la relance
const ITEMS_LIMIT = 50;      // Nombre max d'articles à traiter

const MESSAGE_TEMPLATE = `Bonjour ! 😊

J'ai remarqué que vous avez mis mon article en favoris — il est encore disponible !

✨ N'hésitez pas si vous avez des questions, je réponds très rapidement.
📦 Envoi soigné et rapide, articles emballés avec soin.

À très bientôt !`;

function vintedGet(path, token) {
  return new Promise((resolve) => {
    const options = {
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
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode }); }
        catch (e) { resolve({ data: { raw: data.substring(0, 200) }, status: r.statusCode }); }
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
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.vinted.fr/',
      },
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try { resolve({ data: JSON.parse(data), status: r.statusCode }); }
        catch (e) { resolve({ data: { raw: data.substring(0, 200) }, status: r.statusCode }); }
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Sécuriser l'endpoint (appelé par Vercel cron ou manuellement)
  const authHeader = req.headers.authorization;
  const { secret } = req.query;
  const validPassword = process.env.DASHBOARD_PASSWORD || process.env.WEBHOOK_SECRET;
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = secret === validPassword;
  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.VINTED_ACCESS_TOKEN;
  const userId = process.env.VINTED_USER_ID || '3136330750';

  if (!token) return res.status(500).json({ error: 'VINTED_ACCESS_TOKEN non configuré' });

  // Vérifier expiration du token
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    if (Date.now() > payload.exp * 1000) {
      return res.status(401).json({ error: 'Token Vinted expiré — renouveler dans le dashboard' });
    }
  } catch (e) {}

  const results = { sent: [], skipped: [], errors: [], newWatchers: 0 };
  const today = new Date().toISOString().slice(0, 10);

  // 1. Charger le log des observateurs depuis Shopify
  const { metafieldId, log } = await getWatcherLog();

  // 2. Récupérer les articles Vinted
  const itemsRes = await vintedGet(`/items?user_id=${userId}&page=1&per_page=${ITEMS_LIMIT}&order=newest_first`, token);
  if (!itemsRes.data.items) {
    return res.status(500).json({ error: 'Impossible de récupérer les articles Vinted', detail: itemsRes.data });
  }

  const items = itemsRes.data.items.filter(i => i.status === 'Active' || i.status === 1);

  // 3. Pour chaque article, récupérer les observateurs
  for (const item of items) {
    const watchRes = await vintedGet(`/items/${item.id}/item_watchers?page=1&per_page=50`, token);
    const watchers = watchRes.data.item_watchers || [];

    for (const watcher of watchers) {
      const key = `${item.id}_${watcher.user?.id || watcher.id}`;
      const watcherId = watcher.user?.id || watcher.id;
      const watcherLogin = watcher.user?.login || 'inconnu';

      if (!log[key]) {
        // Nouveau observateur — enregistrer la date
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
        // Vérifier si 3 jours ont passé
        const firstSeen = new Date(log[key].first_seen);
        const daysPassed = Math.floor((Date.now() - firstSeen) / (1000 * 60 * 60 * 24));

        if (daysPassed >= RELANCE_DAYS) {
          // Envoyer le message de relance
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
          await sleep(500); // Respecter les rate limits Vinted
        } else {
          results.skipped.push({ item: item.title, watcher: watcherLogin, days: daysPassed });
        }
      }
    }

    await sleep(200); // Entre chaque article
  }

  // 4. Nettoyer les anciens entrées (articles vendus ou observateurs partis) — garder 30 jours
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(log)) {
    if (log[key].first_seen < cutoff && log[key].messaged) {
      delete log[key];
    }
  }

  // 5. Sauvegarder le log mis à jour
  await saveWatcherLog(metafieldId, log);

  return res.status(200).json({
    ok: true,
    date: today,
    items_checked: items.length,
    new_watchers: results.newWatchers,
    messages_sent: results.sent.length,
    messages_skipped: results.skipped.length,
    errors: results.errors.length,
    details: results,
  });
};

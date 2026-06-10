const https = require('https');

module.exports = async (req, res) => {
  const { code, shop } = req.query;

  if (!code || !shop) {
    return res.status(200).send(
            '<html><body><h2>Params:</h2><pre>' + JSON.stringify(req.query, null, 2) + '</pre></body></html>'
          );
  }

  try {
    const token = await exchangeCode(shop, code);
    res.status(200).send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:30px;max-width:700px">
      <h2>✅ Token Shopify obtenu !</h2>
      <p>Copie cette valeur dans les variables d'environnement Vercel :</p>
      <h3>SHOPIFY_ACCESS_TOKEN</h3>
      <div style="background:#e8f5e9;padding:15px;font-size:16px;word-break:break-all;border:2px solid #4caf50">${token.access_token}</div>
      <p>Shop : ${shop}</p>
      <p>Scopes : ${token.scope}</p>
      </body></html>`);
                   } catch (e) {
          res.status(500).send('<html><body><h2>Erreur:</h2><pre>' + JSON.stringify(String(e), null, 2) + '</pre></body></html>');
                 }
  };

function exchangeCode(shop, code) {
    return new Promise((resolve, reject) => {
          const body = JSON.stringify({
            client_id: process.env.SHOPIFY_CLIENT_ID,
            client_secret: process.env.SHOPIFY_CLIENT_SECRET,
            code,
      });
          const options = {
      hostname: shop,
      path: '/admin/oauth/access_token',
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data)); } });
});
    req.on('error', reject);
    req.write(body);
    req.end();
});
}

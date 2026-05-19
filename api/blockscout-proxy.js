module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { path: apiPath } = req.query;
  if (!apiPath) return res.status(400).json({ error: 'Missing path param' });
  
  try {
    const url = `https://base.blockscout.com/api/v2/${apiPath}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { chain, address } = req.query;
  if (!chain || !address) return res.status(400).json({ error: 'Missing params' });
  
  try {
    const url = `https://tachitrack.vercel.app/api/evm/${chain}/${address}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    return res.status(200).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

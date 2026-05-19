// ExitWise Jeeter Score — /api/jeeter
// Analyzes top holder behavior: are they jeeters or believers?
// Uses /addresses/{addr}/tokens — 1 call per wallet, fast & reliable

const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
const MAX_WALLETS = 10;
const REQ_TIMEOUT = 12000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.method === 'POST' ? req.body : req.query;
  
  let addresses;
  if (body.addresses) {
    addresses = typeof body.addresses === 'string' ? JSON.parse(body.addresses) : body.addresses;
  } else {
    return res.status(400).json({ error: 'Missing addresses field. POST { addresses: ["0x..."] }' });
  }

  // Filter to EOAs only, limit to MAX_WALLETS
  const wallets = addresses
    .filter(a => a && a.match(/^0x[a-fA-F0-9]{40}$/))
    .slice(0, MAX_WALLETS);

  if (wallets.length === 0) {
    return res.status(200).json({ success: true, jeeterRisk: 'LOW', wallets: [], summary: 'No EOA wallets to analyze' });
  }

  try {
    // Fetch token data for all wallets in parallel
    const results = await Promise.allSettled(
      wallets.map(addr => analyzeWallet(addr))
    );

    const walletResults = [];
    let jeeterCount = 0;
    let neutralCount = 0;
    let believerCount = 0;
    let newWalletCount = 0;

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const w = r.value;
        walletResults.push(w);
        if (w.label === 'JEETER') jeeterCount++;
        else if (w.label === 'NEUTRAL') neutralCount++;
        else if (w.label === 'BELIEVER') believerCount++;
        else if (w.label === 'NEW WALLET') newWalletCount++;
      }
    }

    const analyzed = walletResults.length;
    const jeeterPct = analyzed > 0 ? (jeeterCount / analyzed) * 100 : 0;

    let jeeterRisk;
    if (jeeterPct >= 60) jeeterRisk = 'HIGH';
    else if (jeeterPct >= 30) jeeterRisk = 'MEDIUM';
    else jeeterRisk = 'LOW';

    const summary = analyzed > 0
      ? `${jeeterCount} of ${analyzed} top wallets are jeeters (${jeeterPct.toFixed(0)}%)`
      : 'No wallet data available';

    return res.status(200).json({
      success: true,
      jeeterRisk,
      jeeterPct: jeeterPct.toFixed(1),
      jeeterCount,
      neutralCount,
      believerCount,
      newWalletCount,
      analyzed,
      wallets: walletResults,
      summary,
    });

  } catch (err) {
    console.error('Jeeter analysis error:', err.message);
    return res.status(500).json({ error: 'Jeeter analysis failed', details: err.message });
  }
};

// ═══════════════════════════════════════════════════
// WALLET ANALYZER
// ═══════════════════════════════════════════════════

async function analyzeWallet(address) {
  try {
    const res = await fetch(`${BLOCKSCOUT}/addresses/${address}/tokens`, {
      signal: AbortSignal.timeout(REQ_TIMEOUT),
    });

    if (!res.ok) {
      return { address, label: 'UNKNOWN', error: `HTTP ${res.status}`, tokensHeld: 0 };
    }

    const data = await res.json();
    const items = data.items || [];

    // Filter out NFTs — only ERC-20
    const erc20Tokens = items.filter(item => {
      const t = item.token;
      return t && t.type === 'ERC-20';
    });

    const totalTokens = erc20Tokens.length;

    // ── NEW WALLET CHECK ─────────────────────────────
    if (totalTokens < 3) {
      return {
        address,
        label: 'NEW WALLET',
        tokensHeld: totalTokens,
        scamTokens: 0,
        lowHolderTokens: 0,
        score: null,
      };
    }

    // ── ANALYZE TOKEN PORTFOLIO ──────────────────────
    let scamTokens = 0;
    let lowHolderTokens = 0;  // tokens with < 100 holders = likely flip targets
    let highHolderTokens = 0; // tokens with > 1000 holders = legit projects

    for (const item of erc20Tokens) {
      const t = item.token;
      
      // Scam/spam reputation
      if (t.reputation === 'scam' || t.reputation === 'spam') {
        scamTokens++;
      }

      // Holder count analysis
      const holders = parseInt(t.holders_count || '0');
      if (holders < 100) lowHolderTokens++;
      if (holders > 1000) highHolderTokens++;
    }

    const scamRate = totalTokens > 0 ? scamTokens / totalTokens : 0;
    const lowHolderRate = totalTokens > 0 ? lowHolderTokens / totalTokens : 0;

    // ── LABEL LOGIC ─────────────────────────────────
    // JEETER: high scam rate OR mostly low-holder tokens (flip hunter)
    // NEUTRAL: mixed portfolio
    // BELIEVER: holds legit projects, low scam rate
    
    let label;
    let score;

    if (scamRate > 0.3 || (lowHolderRate > 0.6 && totalTokens > 10)) {
      label = 'JEETER';
      score = 1;
    } else if (scamRate > 0.1 || lowHolderRate > 0.4) {
      label = 'NEUTRAL';
      score = 2;
    } else {
      label = 'BELIEVER';
      score = 3;
    }

    return {
      address,
      label,
      score,
      tokensHeld: totalTokens,
      scamTokens,
      lowHolderTokens,
      highHolderTokens,
      scamRate: (scamRate * 100).toFixed(0) + '%',
      lowHolderRate: (lowHolderRate * 100).toFixed(0) + '%',
    };

  } catch (err) {
    // Timeout or network error — skip, don't crash
    return { address, label: 'UNKNOWN', error: err.message, tokensHeld: 0 };
  }
}

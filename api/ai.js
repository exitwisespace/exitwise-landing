// ExitWise AI Agent — /api/ai
// Rule-based paranoid analysis engine

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.method === 'POST' ? req.body : req.query;
  
  let investigationData;
  if (body.data) {
    investigationData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
  } else {
    return res.status(400).json({ error: 'Missing data field. POST { data: <investigation_result> }' });
  }

  try {
    const analysis = generateAnalysis(investigationData);
    return res.status(200).json({
      success: true,
      analysis,
      rawData: investigationData,
    });
  } catch (err) {
    console.error('Analysis error:', err.message);
    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
};

// ═══════════════════════════════════════════════════
// PARANOID RULE-BASED ANALYSIS ENGINE
// ═══════════════════════════════════════════════════

function generateAnalysis(data) {
  const L = [];
  const score = data.scan?.score ?? 0;
  const maxScore = data.scan?.maxScore ?? 22;
  const name = data.token?.name || 'Unknown';
  const symbol = data.token?.symbol || '???';

  // ── THESIS ──────────────────────────────────────────────────────
  const findings = [];
  if (data.audit?.isHoneypot) findings.push('HONEYPOT');
  if (data.audit?.canMint) findings.push('UNLIMITED MINT');
  if (data.audit?.hiddenOwner) findings.push('HIDDEN OWNER');
  if (data.deployer?.ruggedCount > 0) findings.push(`${data.deployer.ruggedCount} RUGS IN DEPLOYER HISTORY`);
  if (data.holders?.concentration?.top3 && parseFloat(data.holders.concentration.top3) > 50) findings.push(`TOP 3 HOLD ${data.holders.concentration.top3}`);
  if (data.osint?.ofacFlagged) findings.push('OFAC SANCTIONED');
  if (data.audit?.canPause) findings.push('PAUSABLE');
  if (data.audit?.canBlacklist) findings.push('BLACKLISTABLE');
  if (data.audit?.cannotSellAll) findings.push('CANNOT SELL ALL');

  let thesis;
  if (score <= 3 && findings.length === 0) {
    thesis = `${name} (${symbol}) scores ${score}/${maxScore}. No major red flags found. Looks clean on surface — but always check who's buying.`;
  } else if (score <= 7) {
    thesis = `${name} (${symbol}) scores ${score}/${maxScore}. Some suspicious patterns detected. Not an obvious scam but proceed with caution.`;
  } else if (score <= 12) {
    thesis = `${name} (${symbol}) scores ${score}/${maxScore}. Multiple red flags. High probability this ends badly.`;
  } else {
    thesis = `${name} (${symbol}) scores ${score}/${maxScore}. Extreme risk. Everything about this token screams exit liquidity trap.`;
  }

  L.push('**THESIS**');
  L.push(thesis);
  L.push('');

  // ── RED FLAGS ───────────────────────────────────────────────────
  L.push('**RED FLAGS**');
  if (findings.length > 0) {
    findings.slice(0, 5).forEach((f, i) => L.push(`${i + 1}. ${f}`));
  } else {
    L.push('None detected from available data.');
  }

  if (data.deployer?.tokensDeployed > 3 && data.deployer?.ruggedCount === 0) {
    L.push(`• Deployer launched ${data.deployer.tokensDeployed} tokens — serial deployer pattern`);
  }
  if (data.holders?.scamTagged > 0) {
    L.push(`• ${data.holders.scamTagged} scam-tagged wallets in holder list`);
  }
  if (data.holders?.whaleCount > 10) {
    L.push(`• ${data.holders.whaleCount} whale wallets (>1% supply) — dump coordination risk`);
  }
  if (data.audit?.buyTax > 0 || data.audit?.sellTax > 0) {
    L.push(`• Tax: buy ${data.audit.buyTax}% / sell ${data.audit.sellTax}% — dev skimming trades`);
  }
  L.push('');

  // ── BULL CASE ───────────────────────────────────────────────────
  L.push('**BULL CASE**');
  if (score > 8 || findings.length > 2) {
    L.push('None found.');
  } else {
    const bulls = [];
    if (data.audit?.isOpenSource) bulls.push('Contract is open source and verified');
    if (data.token?.fdv > 1000000) bulls.push(`FDV $${(data.token.fdv / 1000000).toFixed(1)}M — has real market cap`);
    if (data.holders?.totalHolders > 1000) bulls.push(`${data.holders.totalHolders.toLocaleString()} holders — distributed base`);
    if (data.deployer?.ruggedCount === 0 && data.deployer?.tokensDeployed <= 1) bulls.push('First-time deployer, no rug history');
    if (bulls.length === 0) {
      L.push('None found.');
    } else {
      bulls.forEach(b => L.push(`• ${b}`));
    }
  }
  L.push('');

  // ── WORST CASE ──────────────────────────────────────────────────
  L.push('**WORST CASE**');
  const worst = [];
  if (data.audit?.isHoneypot) {
    worst.push('Contract blocks sells. You buy, price pumps on buys only, dev dumps. You hold bags forever.');
  }
  if (data.audit?.canMint) {
    worst.push('Dev mints infinite supply, dumps on holders. Token goes to zero in minutes.');
  }
  if (data.deployer?.ruggedCount > 0) {
    worst.push(`Deployer already rugged ${data.deployer.ruggedCount} tokens. Same playbook: pump, LP pull, delete socials.`);
  }
  if (data.holders?.concentration?.top3 && parseFloat(data.holders.concentration.top3) > 50) {
    worst.push(`Top 3 wallets own ${data.holders.concentration.top3} of supply. Coordinated dump = -90% in seconds.`);
  }
  if (data.audit?.hiddenOwner) {
    worst.push('Hidden owner can re-activate privileges at any time. Mint, pause, blacklist — all possible.');
  }
  if (worst.length === 0) {
    if (score <= 3) {
      worst.push('Standard memecoin dump. Whale sells, cascading stop-losses, -50% in an hour. Nothing unusual.');
    } else {
      worst.push('Coordinated exit. Dev + insiders dump simultaneously. LP pulled. Socials deleted. -95% in 10 minutes.');
    }
  }
  worst.forEach(w => L.push(`• ${w}`));
  L.push('');

  // ── ACTION ──────────────────────────────────────────────────────
  L.push('**ACTION**');
  if (score <= 3 && findings.length === 0) {
    L.push('SAFE TO HOLD — Clean signals, but set a stop-loss. Trust no one.');
  } else if (score <= 7) {
    L.push('WATCHLIST — Not dangerous enough to panic, but don\'t add size. Monitor LP and deployer wallet.');
  } else if (score <= 12) {
    L.push('PARTIAL EXIT — Too many red flags. Take out your initial, let house money ride if you must.');
  } else if (score <= 17) {
    L.push('EXIT NOW — High probability of coordinated dump. Every minute you hold, you\'re exit liquidity.');
  } else {
    L.push('AVOID — This token has every hallmark of a rug. If you\'re in, get out. If you\'re not, stay away.');
  }

  return L.join('\n');
}

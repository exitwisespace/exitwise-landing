// ExitWise AI Agent — /api/ai
// Honey Router: AI-powered investigation analysis
// Calls /api/investigate, then feeds data to LLM for natural language report

const LLM_API_KEY = process.env.LLM_API_KEY || 'fe_oa_048fa5923c4ad1e131ad03e84c0512516e89f7a3df2efd54';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-5.4-mini';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://vip-sg.freemodel.dev/v1/chat/completions';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.method === 'POST' ? req.body : req.query;
  
  // Accept either raw data (data field) or address+chain (legacy)
  let investigationData;
  if (body.data) {
    investigationData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
  } else {
    return res.status(400).json({ error: 'Missing data field. POST { data: <investigation_result> }' });
  }

  try {

    // ═══════════════════════════════════════════
    // PHASE 2: Build prompts and call LLM
    // ═══════════════════════════════════════════
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(investigationData);

    const llmRes = await fetch(LLM_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`, 
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!llmRes.ok) {
      const llmErr = await llmRes.text().catch(() => 'Unknown LLM error');
      console.error('LLM fallback:', llmErr);
      // Fallback: return raw data with a templated analysis
      const fallbackAnalysis = generateFallbackAnalysis(investigationData);
      return res.status(200).json({
        success: true,
        analysis: fallbackAnalysis,
        rawData: investigationData,
        fallback: true,
      });
    }

    const llmData = await llmRes.json();
    const msg = llmData.choices?.[0]?.message || {};
    const analysis = msg.content || msg.reasoning_content || 'No analysis generated.';

    return res.status(200).json({
      success: true,
      analysis,
      rawData: investigationData,
    });

  } catch (err) {
    console.error('LLM fallback:', err.message);
    // On any error (timeout, API failure, etc), return enhanced fallback analysis
    const fallbackAnalysis = generateFallbackAnalysis(investigationData);
    return res.status(200).json({
      success: true,
      analysis: fallbackAnalysis,
      rawData: investigationData,
      fallback: true,
      error: err.message,
    });
  }
};

// ═══════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════

function buildSystemPrompt() {
  return `You are a paranoid on-chain trench investigator working on Base chain.
Assume every token is guilty until proven otherwise.
Find reasons NOT to trust this token.

Output format:
THESIS — verdict blunt 1-2 kalimat
RED FLAGS — max 5, paling damning duluan
BULL CASE — kalau ada, kalau tidak tulis: None found
WORST CASE — kalau ini coordinated exit, apa yang terjadi
ACTION — AVOID / EXIT NOW / PARTIAL EXIT / WATCHLIST / SAFE TO HOLD + satu kalimat alasan`;
}

function buildUserPrompt(data) {
  const parts = [];

  // Token info
  if (data.token) {
    parts.push(`## Token Info
- Name: ${data.token.name} (${data.token.symbol})
- Address: ${data.token.address}
- Chain: ${data.token.chain}
- Price: $${data.token.priceUsd}
- FDV: $${(data.token.fdv || 0).toLocaleString()}
- DEX: ${data.token.dex || 'N/A'}
- Pair URL: ${data.token.pairUrl || 'N/A'}`);
  }

  // Risk scan
  if (data.scan) {
    parts.push(`## Risk Score
- Score: ${data.scan.score}/${data.scan.maxScore}
- Verdict: ${data.scan.verdict}
- Triggered signals: ${data.scan.triggeredCount}
${data.scan.signals.map(s => `  - [${s.risk}] #${s.id} ${s.name} (+${s.points} pts)`).join('\n')}`);
  }

  // GoPlus audit
  if (data.audit) {
    const redFlags = [];
    if (data.audit.isHoneypot) redFlags.push('HONEYPOT');
    if (data.audit.canMint) redFlags.push('CAN_MINT');
    if (data.audit.canPause) redFlags.push('CAN_PAUSE');
    if (data.audit.canBlacklist) redFlags.push('CAN_BLACKLIST');
    if (data.audit.hiddenOwner) redFlags.push('HIDDEN_OWNER');
    if (data.audit.selfDestruct) redFlags.push('SELF_DESTRUCT');
    if (data.audit.cannotSellAll) redFlags.push('CANNOT_SELL_ALL');
    if (data.audit.ownerChangeBalance) redFlags.push('OWNER_CHANGE_BALANCE');

    parts.push(`## GoPlus Contract Audit
- Honeypot: ${data.audit.isHoneypot ? 'YES ⚠️' : 'No'}
- Buy tax: ${data.audit.buyTax}
- Sell tax: ${data.audit.sellTax}
- Can mint: ${data.audit.canMint ? 'YES ⚠️' : 'No'}
- Can pause: ${data.audit.canPause ? 'YES ⚠️' : 'No'}
- Can blacklist: ${data.audit.canBlacklist ? 'YES ⚠️' : 'No'}
- Hidden owner: ${data.audit.hiddenOwner ? 'YES ⚠️' : 'No'}
- Self-destruct: ${data.audit.selfDestruct ? 'YES ⚠️' : 'No'}
- Open source: ${data.audit.isOpenSource ? 'Yes' : 'No'}
- Cannot sell all: ${data.audit.cannotSellAll ? 'YES ⚠️' : 'No'}
- Owner can change balance: ${data.audit.ownerChangeBalance ? 'YES ⚠️' : 'No'}
${redFlags.length > 0 ? `- **RED FLAGS: ${redFlags.join(', ')}**` : '- No red flags detected'}`);
  } else {
    parts.push(`## GoPlus Contract Audit
- Data unavailable`);
  }

  // Deployer forensics
  if (data.deployer) {
    parts.push(`## Deployer Forensics
- Deployer address: ${data.deployer.address}
- Balance: ${data.deployer.deployerBalance || 'unknown'}
- Tokens/contracts deployed: ${data.deployer.tokensDeployed}
- Rugged/scam tokens found: ${data.deployer.ruggedCount}
${(data.deployer.ruggedTokens || []).length > 0 ? `- Rugged tokens:\n${data.deployer.ruggedTokens.slice(0, 5).map(r => `    - ${r.name} (${r.symbol}) — rep: ${r.reputation}`).join('\n')}` : ''}
${(data.deployer.riskFlags || []).length > 0 ? `- Risk flags:\n${data.deployer.riskFlags.map(f => `    - ${f}`).join('\n')}` : ''}`);
  } else {
    parts.push(`## Deployer Forensics
- Data unavailable`);
  }

  // Holder clustering
  if (data.holders) {
    parts.push(`## Holder Analysis
- Total holders: ${data.holders.totalHolders}
- EOA wallets: ${data.holders.eoaHolders}
- Contract addresses: ${data.holders.contractHolders}
- Scam-tagged holders: ${data.holders.scamTagged}
- Concentration: Top 3 = ${data.holders.concentration?.top3 || 'N/A'}, Top 10 = ${data.holders.concentration?.top10 || 'N/A'}
- Whale count (>1% supply): ${data.holders.whaleCount || 0}
${(data.holders.riskFlags || []).length > 0 ? `- Risk flags:\n${data.holders.riskFlags.map(f => `    - ${f}`).join('\n')}` : ''}`);
  } else {
    parts.push(`## Holder Analysis
- Data unavailable`);
  }

  // OSINT
  if (data.osint) {
    parts.push(`## OSINT Intelligence
- ENS: ${data.osint.ens || 'N/A'}
- OFAC flagged: ${data.osint.ofacFlagged ? 'YES ⚠️' : 'No'}
- Risk score: ${data.osint.riskScore || 'N/A'}/100
${data.osint.riskFlags?.length > 0 ? `- Flags: ${data.osint.riskFlags.join(', ')}` : ''}`);
  } else {
    parts.push(`## OSINT Intelligence
- Data unavailable`);
  }

  parts.push(`\n---
Based on all the above data, provide your safety analysis. Start with the verdict, explain your reasoning, highlight the most critical findings, and end with a confidence level.`);

  return parts.join('\n\n');
}

// ═══════════════════════════════════════════════════
// FALLBACK ANALYSIS (if LLM fails)
// ═══════════════════════════════════════════════════

function generateFallbackAnalysis(data) {
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

  // Add contextual red flags
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

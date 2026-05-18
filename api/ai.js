// ExitWise AI Agent — /api/ai
// Honey Router: AI-powered investigation analysis
// Calls /api/investigate, then feeds data to LLM for natural language report

const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'mimo-v2.5-pro';
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://opengateway.gitlawb.com/v1/chat/completions';

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
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!llmRes.ok) {
      const llmErr = await llmRes.text().catch(() => 'Unknown LLM error');
      console.error('OpenRouter error:', llmErr);
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
    console.error('AI Agent error:', err);
    return res.status(500).json({ error: 'AI analysis failed', details: err.message });
  }
};

// ═══════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════

function buildSystemPrompt() {
  return `You are ExitWise AI — a professional crypto safety analyst and on-chain investigator.

Your job is to analyze raw investigation data about a cryptocurrency token and produce a clear, actionable safety report for everyday users.

RULES:
1. Start with a clear verdict line: "🟢 VERDICT: SAFE" / "🟡 VERDICT: CAUTION" / "🔴 VERDICT: DANGEROUS"
2. Explain WHY in plain English — avoid jargon where possible. If you use technical terms, briefly explain them.
3. Highlight the 3-5 most important findings, ordered by severity.
4. If GoPlus audit flags exist (honeypot, mintable, pausable, blacklist, hidden owner, self-destruct), these are CRITICAL — always mention them prominently.
5. If deployer forensics show previous rug pulls or scam tokens, this is a major red flag.
6. If holder concentration is extreme (>50% in top 3 wallets), warn about dump risk.
7. End with a confidence level: HIGH / MEDIUM / LOW based on data completeness.
8. Use emojis sparingly for readability (🔴🟡🟢⚠️✅❌🔍).
9. Keep the report under 500 words — be concise and scannable.
10. This is NOT financial advice. Always remind users to DYOR.

VERDICT THRESHOLDS:
- SAFE: Risk score ≤ 3/22 AND no GoPlus red flags AND no deployer rug history
- CAUTION: Risk score 4-12/22 OR minor GoPlus flags OR suspicious holder patterns
- DANGEROUS: Risk score > 12/22 OR honeypot detected OR deployer has rug history OR OFAC flagged OR multiple critical GoPlus flags`;
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
- Concentration: Top 3 = ${data.holders.concentration.top3}, Top 10 = ${data.holders.concentration.top10}
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
  const scoreRatio = maxScore > 0 ? score / maxScore : 0;

  // Determine verdict
  let verdict, emoji;
  if (score <= 3 && !data.audit?.isHoneypot) {
    verdict = 'SAFE'; emoji = '🟢';
  } else if (score > 12 || data.audit?.isHoneypot || data.deployer?.ruggedCount > 0) {
    verdict = 'DANGEROUS'; emoji = '🔴';
  } else {
    verdict = 'CAUTION'; emoji = '🟡';
  }

  L.push(`${emoji} VERDICT: ${verdict}`);
  L.push('');
  L.push(`**${data.token?.name || 'Unknown'}** (${data.token?.symbol || '???'}) on ${data.token?.chain || 'unknown'}`);
  L.push(`Risk Score: ${score}/${maxScore}`);
  L.push('');

  // Key findings
  const findings = [];

  if (data.audit?.isHoneypot) {
    findings.push('🔴 HONEYPOT DETECTED — This contract may prevent you from selling your tokens.');
  }
  if (data.audit?.canMint) {
    findings.push('🔴 Contract allows minting new tokens — supply can be inflated at any time.');
  }
  if (data.audit?.hiddenOwner) {
    findings.push('🔴 Hidden owner detected — ownership is obscured.');
  }
  if (data.deployer?.ruggedCount > 0) {
    findings.push(`🔴 Deployer has ${data.deployer.ruggedCount} scam/rugged tokens in their history.`);
  }
  if (data.holders?.concentration?.top3) {
    const top3 = parseFloat(data.holders.concentration.top3);
    if (top3 > 50) {
      findings.push(`🟠 Extreme holder concentration: Top 3 wallets own ${data.holders.concentration.top3} of supply.`);
    }
  }
  if (data.osint?.ofacFlagged) {
    findings.push('🔴 OFAC SANCTIONED address detected.');
  }

  if (findings.length > 0) {
    L.push('**Key Findings:**');
    findings.forEach(f => L.push(f));
  } else {
    L.push('✅ No critical red flags detected in the available data.');
  }

  L.push('');
  L.push('⚠️ *Note: This is an automated fallback analysis. The AI model was unavailable. Always DYOR.*');
  L.push(`\nConfidence: LOW (fallback mode)`);

  return L.join('\n');
}

// ExitWise OSINT Investigation API — /api/investigate
// v2: Deployer forensics + Holder clustering + GoPlus audit + TACHITRACK

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, chain } = req.method === 'POST' ? req.body : req.query;
  
  if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return res.status(400).json({ error: 'Invalid contract address' });
  }

  const targetChain = chain || 'base';
  const BLOCKSCOUT = 'https://base.blockscout.com/api/v2';
  const TACHITRACK = 'https://tachitrack.vercel.app';
  const GOPLUS = 'https://api.gopluslabs.io/api/v1';

  try {
    // Phase 1: Get token basics + contract info
    const [dexRes, contractRes] = await Promise.allSettled([
      fetchDexScreener(address, targetChain),
      fetchSmartContract(address, BLOCKSCOUT),
    ]);

    const dex = dexRes.status === 'fulfilled' ? dexRes.value : null;
    const contract = contractRes.status === 'fulfilled' ? contractRes.value : null;
    const deployerAddr = contract?.creator_address_hash || null;

    // Phase 2: Parallel deep investigations
    const [holdersRes, deployerRes, goplusRes, tachiRes, tokenHoldersRes] = await Promise.allSettled([
      // Get token holders (top 50)
      fetchTokenHolders(address, BLOCKSCOUT),
      // Deployer forensics (only if we have deployer address)
      deployerAddr ? fetchDeployerForensics(deployerAddr, address, BLOCKSCOUT) : Promise.resolve(null),
      // GoPlus contract audit
      fetchGoPlus(address, targetChain, GOPLUS),
      // TACHITRACK OSINT
      fetchTachitrack(address, targetChain, TACHITRACK),
      // Blockscout address info for the token contract
      fetchAddressInfo(address, BLOCKSCOUT),
    ]);

    const rawHolders = holdersRes.status === 'fulfilled' ? holdersRes.value : null;
    const deployerData = deployerRes.status === 'fulfilled' ? deployerRes.value : null;
    const goplus = goplusRes.status === 'fulfilled' ? goplusRes.value : null;
    const tachi = tachiRes.status === 'fulfilled' ? tachiRes.value : null;
    const addrInfo = tokenHoldersRes.status === 'fulfilled' ? tokenHoldersRes.value : null;

    // ═══════════════════════════════════════════
    // ASSEMBLE RESULTS
    // ═══════════════════════════════════════════

    const token = dex ? {
      name: dex.baseToken?.name || contract?.name || 'Unknown',
      symbol: dex.baseToken?.symbol || '???',
      address,
      chain: dex.chainId || targetChain,
      priceUsd: parseFloat(dex.priceUsd) || 0,
      fdv: dex.fdv || 0,
      dex: dex.dexId,
      pairUrl: dex.url,
    } : { name: contract?.name || 'Unknown', symbol: '???', address, chain: targetChain, priceUsd: 0, fdv: 0 };

    const scan = computeRiskScore(dex, addrInfo);
    const socials = extractSocials(dex);
    const audit = formatGoPlusAudit(goplus);
    const osint = formatTachitrackOSINT(tachi);

    // Deployer forensics
    const deployer = deployerData ? {
      address: deployerAddr,
      creationTx: contract?.creation_transaction_hash || null,
      creationDate: deployerData.creationDate || null,
      deployerBalance: deployerData.balance || null,
      tokensDeployed: deployerData.tokensDeployed || 0,
      deployedTokens: deployerData.deployedTokens || [],
      ruggedTokens: deployerData.ruggedTokens || [],
      ruggedCount: deployerData.ruggedCount || 0,
      otherTokensHeld: deployerData.otherTokensHeld || [],
      riskFlags: deployerData.riskFlags || [],
    } : deployerAddr ? { address: deployerAddr, creationTx: contract?.creation_transaction_hash } : null;

    // Holder clustering
    const holders = rawHolders ? analyzeHolderCluster(rawHolders, dex) : null;

    // Generate report
    const report = generateReport(token, scan, socials, deployer, audit, osint, holders);

    return res.status(200).json({
      success: true,
      token,
      scan,
      socials,
      deployer,
      audit,
      osint,
      holders,
      report,
      investigatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Investigation error:', err);
    return res.status(500).json({ error: 'Investigation failed', details: err.message });
  }
};

// ═══════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════

async function fetchDexScreener(address, chain) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  const pairs = data.pairs || [];
  return pairs.find(p => p.chainId === chain) || pairs[0] || null;
}

async function fetchSmartContract(address, BASE) {
  const res = await fetch(`${BASE}/smart-contracts/${address}`, {
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchAddressInfo(address, BASE) {
  const res = await fetch(`${BASE}/addresses/${address}`, {
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function fetchTokenHolders(address, BASE) {
  const res = await fetch(`${BASE}/tokens/${address}/holders`, {
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.items || [];
}

async function fetchDeployerForensics(deployerAddr, tokenAddress, BASE) {
  try {
    // Get deployer address info + their held tokens + recent txs
    const [addrRes, tokensRes, txsRes] = await Promise.allSettled([
      fetch(`${BASE}/addresses/${deployerAddr}`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${BASE}/addresses/${deployerAddr}/tokens`, { signal: AbortSignal.timeout(10000) }),
      fetch(`${BASE}/addresses/${deployerAddr}/transactions`, { signal: AbortSignal.timeout(10000) }),
    ]);

    let result = {
      balance: null,
      tokensDeployed: 0,
      deployedTokens: [],
      ruggedTokens: [],
      ruggedCount: 0,
      otherTokensHeld: [],
      creationDate: null,
      riskFlags: [],
    };

    // Deployer address info
    if (addrRes.status === 'fulfilled' && addrRes.value.ok) {
      const addr = await addrRes.value.json();
      result.balance = addr.coin_balance ? (parseInt(addr.coin_balance) / 1e18).toFixed(4) + ' ETH' : null;
    }

    // Tokens held by deployer
    if (tokensRes.status === 'fulfilled' && tokensRes.value.ok) {
      const data = await tokensRes.value.json();
      const items = data.items || [];
      
      // Separate: the investigated token vs other tokens
      for (const item of items) {
        const t = item.token;
        if (!t) continue;
        
        const isTarget = t.address_hash?.toLowerCase() === tokenAddress.toLowerCase();
        const balance = parseFloat(item.value) / Math.pow(10, parseInt(t.decimals || '18'));
        
        const tokenEntry = {
          name: t.name,
          symbol: t.symbol,
          address: t.address_hash,
          holders: t.holders_count ? parseInt(t.holders_count) : null,
          marketCap: t.circulating_market_cap ? parseFloat(t.circulating_market_cap) : null,
          volume24h: t.volume_24h ? parseFloat(t.volume_24h) : null,
          reputation: t.reputation || 'unknown',
          balance: balance,
        };

        if (isTarget) continue; // Skip the target token
        
        // Flag suspicious tokens: low holders, low volume, scam reputation
        if (t.reputation === 'scam' || t.reputation === 'spam') {
          result.ruggedTokens.push(tokenEntry);
        }
        
        result.otherTokensHeld.push(tokenEntry);
      }
    }

    // Count how many contracts this deployer created
    if (txsRes.status === 'fulfilled' && txsRes.value.ok) {
      const txData = await txsRes.value.json();
      const txs = txData.items || [];
      
      const contractCreations = txs.filter(tx => 
        tx.transaction_types?.includes('contract_creation') || 
        tx.created_contract
      );
      result.tokensDeployed = contractCreations.length;
      result.deployedTokens = contractCreations.map(tx => ({
        hash: tx.hash,
        createdContract: tx.created_contract?.hash || null,
        timestamp: tx.timestamp,
        status: tx.status,
      }));

      // Get creation date of deployer's first tx
      if (txs.length > 0) {
        result.creationDate = txs[txs.length - 1]?.timestamp || null;
      }
    }

    // Analyze risk flags
    if (result.ruggedTokens.length > 0) {
      result.riskFlags.push(`${result.ruggedTokens.length} scam/spam tokens in wallet`);
    }
    if (result.tokensDeployed === 0) {
      result.riskFlags.push('No contract creation txs found (may use different deployer pattern)');
    }

    return result;
  } catch (e) {
    console.error('Deployer forensics error:', e.message);
    return null;
  }
}

async function fetchGoPlus(address, chain, BASE) {
  try {
    const chainMap = { base: '8453', eth: '1', bsc: '56', arbitrum: '42161', optimism: '10' };
    const chainId = chainMap[chain] || '8453';
    const res = await fetch(`${BASE}/token_security/${chainId}?contract_addresses=${address}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result?.[address.toLowerCase()] || data.result?.[address] || null;
  } catch (e) {
    return null;
  }
}

async function fetchTachitrack(address, chain, BASE) {
  try {
    const res = await fetch(`${BASE}/api/evm/${chain}/${address}`, { 
      signal: AbortSignal.timeout(15000) 
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════
// HOLDER CLUSTERING ANALYSIS
// ═══════════════════════════════════════════════════

function analyzeHolderCluster(holders, dex) {
  if (!holders || holders.length === 0) return null;

  const totalSupply = dex?.fdv && dex?.priceUsd 
    ? dex.fdv / dex.priceUsd 
    : null;

  let contractHolders = 0;
  let eoaHolders = 0;
  let scamTagged = 0;
  let totalValue = BigInt(0);
  const topHolders = [];

  for (const h of holders) {
    const addr = h.address || {};
    const value = BigInt(h.value || '0');
    totalValue += value;

    if (addr.is_contract) contractHolders++;
    else eoaHolders++;
    
    if (addr.is_scam) scamTagged++;

    topHolders.push({
      address: addr.hash,
      isContract: addr.is_contract || false,
      isScam: addr.is_scam || false,
      reputation: addr.reputation || 'ok',
      name: addr.name || null,
      implementation: addr.implementations?.[0]?.name || null,
      tags: [
        ...(addr.private_tags || []).map(t => t.name),
        ...(addr.public_tags || []).map(t => t.name),
      ],
      value: h.value,
    });
  }

  // Calculate concentration
  const top3Value = topHolders.slice(0, 3).reduce((sum, h) => sum + BigInt(h.value), BigInt(0));
  const top10Value = topHolders.slice(0, 10).reduce((sum, h) => sum + BigInt(h.value), BigInt(0));
  
  const top3Pct = totalValue > 0n ? Number(top3Value * 10000n / totalValue) / 100 : 0;
  const top10Pct = totalValue > 0n ? Number(top10Value * 10000n / totalValue) / 100 : 0;

  // Risk flags
  const riskFlags = [];
  if (top3Pct > 50) riskFlags.push(`Top 3 holders own ${top3Pct.toFixed(1)}% — extreme concentration`);
  if (top10Pct > 80) riskFlags.push(`Top 10 holders own ${top10Pct.toFixed(1)}% — high concentration`);
  if (contractHolders > holders.length * 0.3) riskFlags.push(`${contractHolders}/${holders.length} holders are contracts — possible bots`);
  if (scamTagged > 0) riskFlags.push(`${scamTagged} holders tagged as scam`);

  // Whale detection
  const whales = topHolders.filter(h => {
    const pct = totalValue > 0n ? Number(BigInt(h.value) * 10000n / totalValue) / 100 : 0;
    return pct > 1;
  }).map(h => ({
    ...h,
    percentage: totalValue > 0n ? (Number(BigInt(h.value) * 10000n / totalValue) / 100).toFixed(2) + '%' : 'unknown',
  }));

  return {
    totalHolders: holders.length,
    contractHolders,
    eoaHolders,
    scamTagged,
    concentration: {
      top3: top3Pct.toFixed(1) + '%',
      top10: top10Pct.toFixed(1) + '%',
    },
    whaleCount: whales.length,
    whales: whales.slice(0, 10), // Top 10 whales only
    riskFlags,
  };
}

// ═══════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════

function extractSocials(dex) {
  if (!dex) return {};
  const info = dex.info || {};
  return {
    websites: info.websites || [],
    socials: info.socials || [],
  };
}

function formatGoPlusAudit(gp) {
  if (!gp) return null;
  return {
    isHoneypot: gp.is_honeypot === '1',
    buyTax: gp.buy_tax ? (parseFloat(gp.buy_tax) * 100).toFixed(1) + '%' : 'unknown',
    sellTax: gp.sell_tax ? (parseFloat(gp.sell_tax) * 100).toFixed(1) + '%' : 'unknown',
    canMint: gp.is_mintable === '1',
    canPause: gp.is_pausable === '1',
    canBlacklist: gp.is_blacklisted === '1',
    hiddenOwner: gp.hidden_owner === '1',
    selfDestruct: gp.selfdestruct === '1',
    isOpenSource: gp.is_open_source === '1',
    holderCount: gp.holder_count || null,
    cannotSellAll: gp.cannot_sell_all === '1',
    ownerChangeBalance: gp.owner_change_balance === '1',
  };
}

function formatTachitrackOSINT(tt) {
  if (!tt) return null;
  return {
    balance: tt.balance || null,
    txCount: tt.txCount || null,
    isContract: tt.isContract ?? null,
    ens: tt.ens || null,
    ofacFlagged: tt.ofacFlagged ?? false,
    riskScore: tt.riskScore || null,
    riskFlags: tt.riskFlags || [],
    lookupUrls: tt.lookupUrls || {},
  };
}

function computeRiskScore(dex, addrInfo) {
  if (!dex) return { score: 0, signals: [], verdict: 'UNKNOWN' };

  const liquidity = dex.liquidity?.usd || 0;
  const buys24h = dex.txns?.h24?.buys || 0;
  const sells24h = dex.txns?.h24?.sells || 0;
  const priceChangeH24 = dex.priceChange?.h24 || 0;
  const totalTxns = buys24h + sells24h;
  const rugRatio = totalTxns > 0 ? sells24h / totalTxns : 0;
  const pairCreatedAt = dex.pairCreatedAt || 0;
  const pairAgeHours = pairCreatedAt ? (Date.now() - pairCreatedAt) / (1000 * 60 * 60) : null;
  const holderCount = addrInfo?.holders_count ? parseInt(addrInfo.holders_count) : null;

  let score = 0;
  const signals = [];

  if (liquidity < 1000) { score += 3; signals.push({ id: '01', name: 'Liquidity', risk: 'CRITICAL', points: 3 }); }
  else if (liquidity < 10000) { score += 2; signals.push({ id: '01', name: 'Liquidity', risk: 'HIGH', points: 2 }); }

  const dump = Math.abs(Math.min(priceChangeH24, 0));
  if (dump > 50) { score += 2; signals.push({ id: '02', name: 'ATH Dump', risk: 'HIGH', points: 2 }); }
  else if (dump > 30) { score += 1; signals.push({ id: '02', name: 'ATH Dump', risk: 'MEDIUM', points: 1 }); }

  if (rugRatio > 0.5) { score += 3; signals.push({ id: '03', name: 'Rug Ratio', risk: 'CRITICAL', points: 3 }); }
  else if (rugRatio > 0.1) { score += 1; signals.push({ id: '03', name: 'Rug Ratio', risk: 'MEDIUM', points: 1 }); }

  if (holderCount !== null && holderCount < 10) { score += 3; signals.push({ id: '07', name: 'Holders', risk: 'CRITICAL', points: 3 }); }
  else if (holderCount !== null && holderCount < 50) { score += 2; signals.push({ id: '07', name: 'Holders', risk: 'HIGH', points: 2 }); }

  if (pairAgeHours !== null && pairAgeHours < 1) { score += 3; signals.push({ id: '13', name: 'Token Age', risk: 'CRITICAL', points: 3 }); }
  else if (pairAgeHours !== null && pairAgeHours < 24) { score += 2; signals.push({ id: '13', name: 'Token Age', risk: 'HIGH', points: 2 }); }

  score = Math.min(score, 22);
  const verdict = score <= 3 ? 'HOLD' : score <= 7 ? 'PARTIAL EXIT' : score <= 12 ? 'MAJOR EXIT' : 'FULL EXIT';

  return { score, maxScore: 22, verdict, signals, triggeredCount: signals.length };
}

// ═══════════════════════════════════════════════════
// REPORT GENERATOR
// ═══════════════════════════════════════════════════

function generateReport(token, scan, socials, deployer, audit, osint, holders) {
  const L = [];
  const sep = '─'.repeat(40);

  L.push(`# 🔍 ExitWise Investigation Report`);
  L.push(`**${token.name}** (${token.symbol}) · ${token.chain?.toUpperCase()}`);
  L.push(`\`${token.address}\``);
  L.push(sep);

  // Risk Score
  L.push(`\n## ⚡ Risk Score: ${scan.score}/${scan.maxScore} → **${scan.verdict}**`);
  if (scan.signals.length > 0) {
    L.push(`\n**Triggered signals (${scan.triggeredCount}):**`);
    for (const s of scan.signals) {
      const icon = s.risk === 'CRITICAL' ? '🔴' : s.risk === 'HIGH' ? '🟠' : '🟡';
      L.push(`${icon} #${s.id} ${s.name} — ${s.risk} (+${s.points})`);
    }
  } else {
    L.push('✅ No signals triggered.');
  }

  // Market Data
  L.push(`\n## 📊 Market Data`);
  L.push(`- **Price:** $${token.priceUsd < 0.000001 ? token.priceUsd.toExponential(2) : token.priceUsd}`);
  L.push(`- **FDV:** $${(token.fdv || 0).toLocaleString()}`);
  L.push(`- **Dex:** ${token.dex || 'N/A'}`);

  // Social
  if (socials?.websites?.length || socials?.socials?.length) {
    L.push(`\n## 🌐 Social & Links`);
    for (const w of (socials.websites || [])) L.push(`- 🌐 ${w.url}`);
    for (const s of (socials.socials || [])) {
      const icons = { twitter: '🐦', telegram: '✈️', discord: '💬' };
      L.push(`- ${icons[s.type] || '🔗'} ${s.type}: ${s.url}`);
    }
  }

  // Contract Audit
  if (audit) {
    L.push(`\n## 🛡️ Contract Audit (GoPlus)`);
    const flags = [];
    if (audit.isHoneypot) flags.push('🍯 **HONEYPOT**');
    if (audit.canMint) flags.push('🖨️ Can mint new tokens');
    if (audit.canPause) flags.push('⏸️ Can pause trading');
    if (audit.canBlacklist) flags.push('🚫 Can blacklist wallets');
    if (audit.hiddenOwner) flags.push('👤 Hidden owner');
    if (audit.selfDestruct) flags.push('💣 Self-destruct');
    if (audit.cannotSellAll) flags.push('🔒 Cannot sell all');
    if (audit.ownerChangeBalance) flags.push('✏️ Owner can change balances');
    
    if (flags.length) {
      L.push('\n**⚠️ Red Flags:**');
      flags.forEach(f => L.push(`- ${f}`));
    } else {
      L.push('\n✅ No major red flags.');
    }
    L.push(`- Buy tax: ${audit.buyTax} | Sell tax: ${audit.sellTax}`);
    L.push(`- Open source: ${audit.isOpenSource ? '✓' : '✗'}`);
  }

  // ═══════════════════════════════════════════
  // DEPLOYER FORENSICS (NEW)
  // ═══════════════════════════════════════════
  if (deployer) {
    L.push(`\n## 🔎 Deployer Forensics`);
    L.push(`- **Address:** \`${deployer.address}\``);
    if (deployer.creationTx) L.push(`- **Creation tx:** \`${deployer.creationTx}\``);
    if (deployer.creationDate) L.push(`- **First activity:** ${deployer.creationDate}`);
    if (deployer.deployerBalance) L.push(`- **Balance:** ${deployer.deployerBalance}`);
    
    if (deployer.tokensDeployed > 0) {
      L.push(`- **Contracts deployed:** ${deployer.tokensDeployed}`);
      for (const t of deployer.deployedTokens.slice(0, 5)) {
        L.push(`  - \`${t.createdContract || t.hash}\` (${t.timestamp?.slice(0,10) || 'N/A'}) ${t.status === 'ok' ? '✓' : '✗'}`);
      }
    }

    if (deployer.ruggedCount > 0) {
      L.push(`\n**🔴 Rugged/Scam Tokens:**`);
      for (const r of deployer.ruggedTokens.slice(0, 5)) {
        L.push(`- ${r.name} (${r.symbol}) — holders: ${r.holders || 'N/A'}, rep: ${r.reputation}`);
      }
    }

    if (deployer.riskFlags.length > 0) {
      L.push(`\n**⚠️ Risk Flags:**`);
      deployer.riskFlags.forEach(f => L.push(`- ${f}`));
    }

    if (deployer.otherTokensHeld.length > 0) {
      L.push(`\n**Other tokens held by deployer (${deployer.otherTokensHeld.length}):**`);
      for (const t of deployer.otherTokensHeld.slice(0, 8)) {
        const mc = t.marketCap ? `$${(t.marketCap / 1e6).toFixed(1)}M` : 'N/A';
        L.push(`- ${t.name} (${t.symbol}) — MC: ${mc}, holders: ${t.holders || 'N/A'}, rep: ${t.reputation}`);
      }
    }
  }

  // ═══════════════════════════════════════════
  // HOLDER CLUSTERING (NEW)
  // ═══════════════════════════════════════════
  if (holders) {
    L.push(`\n## 👥 Holder Analysis`);
    L.push(`- **Total holders:** ${holders.totalHolders.toLocaleString()}`);
    L.push(`- **EOA wallets:** ${holders.eoaHolders}`);
    L.push(`- **Contract addresses:** ${holders.contractHolders}`);
    L.push(`- **Scam-tagged:** ${holders.scamTagged}`);
    L.push(`- **Concentration:** Top 3 = ${holders.concentration.top3}, Top 10 = ${holders.concentration.top10}`);
    
    if (holders.riskFlags.length > 0) {
      L.push(`\n**⚠️ Holder Risk Flags:**`);
      holders.riskFlags.forEach(f => L.push(`- ${f}`));
    }

    if (holders.whales.length > 0) {
      L.push(`\n**🐋 Top Whales (>1% supply):**`);
      for (const w of holders.whales) {
        const tags = w.tags.length ? ` [${w.tags.join(', ')}]` : '';
        const impl = w.implementation ? ` (${w.implementation})` : '';
        L.push(`- \`${w.address?.slice(0,8)}...\` — ${w.percentage}${impl}${tags}`);
      }
    }
  }

  // OSINT
  if (osint) {
    L.push(`\n## 🕵️ OSINT Intelligence`);
    if (osint.ens) L.push(`- ENS: ${osint.ens}`);
    if (osint.ofacFlagged) L.push(`- 🔴 **OFAC SANCTIONED**`);
    if (osint.riskScore) L.push(`- Risk score: ${osint.riskScore}/100`);
    if (osint.riskFlags?.length) L.push(`- Flags: ${osint.riskFlags.join(', ')}`);
    if (osint.lookupUrls && Object.keys(osint.lookupUrls).length) {
      L.push('\n**Investigation links:**');
      for (const [name, url] of Object.entries(osint.lookupUrls)) {
        if (url) L.push(`- [${name}](${url})`);
      }
    }
  }

  L.push(`\n${sep}`);
  L.push(`*ExitWise OSINT Engine v2 · ${new Date().toISOString()}*`);
  L.push(`*Not financial advice. Always DYOR.*`);

  return L.join('\n');
}

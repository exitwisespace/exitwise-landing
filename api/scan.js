// ExitWise Risk Score API — /api/scan
// Fetches token data from DexScreener + Blockscout (on-chain)
// Computes Risk Score (0-22) with 14 signals

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, chain } = req.method === 'POST' ? req.body : req.query;
  
  if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return res.status(400).json({ error: 'Invalid contract address' });
  }

  try {
    // Parallel fetch: DexScreener + Blockscout
    const [dexData, blockscoutData] = await Promise.allSettled([
      fetchDexScreener(address, chain || 'base'),
      fetchBlockscout(address),
    ]);

    const pair = dexData.status === 'fulfilled' ? dexData.value : null;
    const onchain = blockscoutData.status === 'fulfilled' ? blockscoutData.value : null;

    if (!pair) {
      return res.status(404).json({ error: 'No trading pair found for this address' });
    }

    // Extract DexScreener metrics
    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const buys24h = pair.txns?.h24?.buys || 0;
    const sells24h = pair.txns?.h24?.sells || 0;
    const priceChangeH1 = pair.priceChange?.h1 || 0;
    const priceChangeH24 = pair.priceChange?.h24 || 0;
    const priceUsd = parseFloat(pair.priceUsd) || 0;
    const fdv = pair.fdv || 0;
    const pairCreatedAt = pair.pairCreatedAt || 0;
    const pairAgeHours = pairCreatedAt ? (Date.now() - pairCreatedAt) / (1000 * 60 * 60) : null;
    const buySellRatio = sells24h > 0 ? buys24h / sells24h : buys24h > 0 ? 999 : 0;
    const totalTxns = buys24h + sells24h;
    const rugRatio = totalTxns > 0 ? sells24h / totalTxns : 0;

    // Extract Blockscout on-chain metrics
    const holderCount = onchain?.holders || null;
    const topHolderPct = onchain?.topHolderPct || null;
    const isVerified = onchain?.isVerified ?? null;
    const hasOwner = onchain?.hasOwner ?? null;
    const isProxy = onchain?.isProxy ?? null;
    const creationTxHash = onchain?.creationTxHash || null;
    const tokenType = onchain?.tokenType || null;

    // Compute Risk Score
    let score = 0;
    const signals = [];

    // ═══════════════════════════════════════════════════
    // CORE SIGNALS (from DexScreener)
    // ═══════════════════════════════════════════════════

    // #01 Liquidity
    if (liquidity < 1000) {
      score += 3;
      signals.push({ id: '01', name: 'Liquidity', trigger: `< $1,000`, points: 3, risk: 'CRITICAL', value: `$${liquidity.toFixed(0)}` });
    } else if (liquidity < 10000) {
      score += 2;
      signals.push({ id: '01', name: 'Liquidity', trigger: `< $10,000`, points: 2, risk: 'HIGH', value: `$${liquidity.toFixed(0)}` });
    } else {
      signals.push({ id: '01', name: 'Liquidity', trigger: 'OK', points: 0, risk: 'SAFE', value: `$${liquidity.toFixed(0)}` });
    }

    // #02 ATH Dump (24h price change as proxy)
    const dump = Math.abs(Math.min(priceChangeH24, 0));
    if (dump > 50) {
      score += 2;
      signals.push({ id: '02', name: 'ATH Dump', trigger: `> 50% from peak`, points: 2, risk: 'HIGH', value: `-${dump.toFixed(1)}%` });
    } else if (dump > 30) {
      score += 1;
      signals.push({ id: '02', name: 'ATH Dump', trigger: `> 30% from peak`, points: 1, risk: 'MEDIUM', value: `-${dump.toFixed(1)}%` });
    } else {
      signals.push({ id: '02', name: 'ATH Dump', trigger: 'OK', points: 0, risk: 'SAFE', value: `${priceChangeH24 >= 0 ? '+' : ''}${priceChangeH24.toFixed(1)}%` });
    }

    // #03 Rug Ratio (sell pressure ratio)
    if (rugRatio > 0.5) {
      score += 3;
      signals.push({ id: '03', name: 'Rug Ratio', trigger: `> 0.5`, points: 3, risk: 'CRITICAL', value: rugRatio.toFixed(2) });
    } else if (rugRatio > 0.1) {
      score += 1;
      signals.push({ id: '03', name: 'Rug Ratio', trigger: `> 0.1`, points: 1, risk: 'MEDIUM', value: rugRatio.toFixed(2) });
    } else {
      signals.push({ id: '03', name: 'Rug Ratio', trigger: 'OK', points: 0, risk: 'SAFE', value: rugRatio.toFixed(2) });
    }

    // ═══════════════════════════════════════════════════
    // ON-CHAIN SIGNALS (from Blockscout)
    // ═══════════════════════════════════════════════════

    // #04 Contract Renounced
    if (hasOwner === true && !isProxy) {
      score += 2;
      signals.push({ id: '04', name: 'Renounced', trigger: 'NOT revoked', points: 2, risk: 'HIGH', value: 'Owner can modify contract' });
    } else if (hasOwner === true && isProxy) {
      score += 1;
      signals.push({ id: '04', name: 'Renounced', trigger: 'Proxy with owner', points: 1, risk: 'MEDIUM', value: 'Proxy contract — owner can upgrade' });
    } else if (hasOwner === false) {
      signals.push({ id: '04', name: 'Renounced', trigger: 'Revoked', points: 0, risk: 'SAFE', value: 'No owner — cannot modify' });
    } else {
      signals.push({ id: '04', name: 'Renounced', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Could not verify ownership' });
    }

    // #05 Top 10 Holders Concentration
    if (topHolderPct !== null) {
      if (topHolderPct > 80) {
        score += 3;
        signals.push({ id: '05', name: 'Top 10 Holders', trigger: `> 80% supply`, points: 3, risk: 'CRITICAL', value: `${topHolderPct.toFixed(1)}%` });
      } else if (topHolderPct > 60) {
        score += 2;
        signals.push({ id: '05', name: 'Top 10 Holders', trigger: `> 60% supply`, points: 2, risk: 'HIGH', value: `${topHolderPct.toFixed(1)}%` });
      } else if (topHolderPct > 40) {
        score += 1;
        signals.push({ id: '05', name: 'Top 10 Holders', trigger: `> 40% supply`, points: 1, risk: 'MEDIUM', value: `${topHolderPct.toFixed(1)}%` });
      } else {
        signals.push({ id: '05', name: 'Top 10 Holders', trigger: 'OK', points: 0, risk: 'SAFE', value: `${topHolderPct.toFixed(1)}%` });
      }
    } else {
      signals.push({ id: '05', name: 'Top 10 Holders', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Holder data unavailable' });
    }

    // #06 Volume 24h
    if (volume24h < 5000) {
      score += 2;
      signals.push({ id: '06', name: 'Volume 24h', trigger: `< $5,000`, points: 2, risk: 'HIGH', value: `$${volume24h.toFixed(0)}` });
    } else if (volume24h < 50000) {
      score += 1;
      signals.push({ id: '06', name: 'Volume 24h', trigger: `< $50,000`, points: 1, risk: 'MEDIUM', value: `$${volume24h.toFixed(0)}` });
    } else {
      signals.push({ id: '06', name: 'Volume 24h', trigger: 'OK', points: 0, risk: 'SAFE', value: `$${volume24h.toFixed(0)}` });
    }

    // #07 Holder Count
    if (holderCount !== null) {
      if (holderCount < 10) {
        score += 3;
        signals.push({ id: '07', name: 'Holders', trigger: `< 10`, points: 3, risk: 'CRITICAL', value: `${holderCount} holders` });
      } else if (holderCount < 50) {
        score += 2;
        signals.push({ id: '07', name: 'Holders', trigger: `< 50`, points: 2, risk: 'HIGH', value: `${holderCount} holders` });
      } else if (holderCount < 200) {
        score += 1;
        signals.push({ id: '07', name: 'Holders', trigger: `< 200`, points: 1, risk: 'MEDIUM', value: `${holderCount} holders` });
      } else {
        signals.push({ id: '07', name: 'Holders', trigger: 'OK', points: 0, risk: 'SAFE', value: `${holderCount.toLocaleString()} holders` });
      }
    } else {
      signals.push({ id: '07', name: 'Holders', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Holder data unavailable' });
    }

    // #08 Bot Rate (estimate: if buys >> sells with low holder count, likely bots)
    if (holderCount !== null && totalTxns > 0) {
      const txnPerHolder = totalTxns / Math.max(holderCount, 1);
      const botEstimate = txnPerHolder > 20 ? 'high' : txnPerHolder > 10 ? 'medium' : 'low';
      if (txnPerHolder > 20) {
        score += 2;
        signals.push({ id: '08', name: 'Bot Rate', trigger: `> 60% estimated`, points: 2, risk: 'CRITICAL', value: `${txnPerHolder.toFixed(1)} txns/holder` });
      } else if (txnPerHolder > 10) {
        score += 1;
        signals.push({ id: '08', name: 'Bot Rate', trigger: `> 40% estimated`, points: 1, risk: 'HIGH', value: `${txnPerHolder.toFixed(1)} txns/holder` });
      } else {
        signals.push({ id: '08', name: 'Bot Rate', trigger: 'Low', points: 0, risk: 'SAFE', value: `${txnPerHolder.toFixed(1)} txns/holder` });
      }
    } else {
      signals.push({ id: '08', name: 'Bot Rate', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Insufficient data' });
    }

    // #09 Smart Money (check if token has decent liquidity + holders = smart money present)
    if (holderCount !== null && liquidity > 0) {
      const liqPerHolder = liquidity / Math.max(holderCount, 1);
      if (holderCount < 20 && liquidity < 5000) {
        score += 1;
        signals.push({ id: '09', name: 'Smart Money', trigger: '0 detected', points: 1, risk: 'MEDIUM', value: 'No smart money indicators' });
      } else if (liqPerHolder > 100 && holderCount > 50) {
        signals.push({ id: '09', name: 'Smart Money', trigger: 'Detected', points: 0, risk: 'SAFE', value: `$${liqPerHolder.toFixed(0)}/holder avg` });
      } else {
        signals.push({ id: '09', name: 'Smart Money', trigger: 'Neutral', points: 0, risk: 'SAFE', value: 'No clear signal' });
      }
    } else {
      signals.push({ id: '09', name: 'Smart Money', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Insufficient data' });
    }

    // #10 Buy/Sell Ratio
    if (buySellRatio < 0.5) {
      score += 1;
      signals.push({ id: '10', name: 'Buy/Sell Ratio', trigger: `< 0.5x`, points: 1, risk: 'HIGH', value: `${buySellRatio.toFixed(2)}x` });
    } else {
      signals.push({ id: '10', name: 'Buy/Sell Ratio', trigger: 'OK', points: 0, risk: 'SAFE', value: `${buySellRatio.toFixed(2)}x` });
    }

    // #11 1h Price Change
    if (priceChangeH1 < -20) {
      score += 2;
      signals.push({ id: '11', name: '1h Price', trigger: `< -20%`, points: 2, risk: 'HIGH', value: `${priceChangeH1.toFixed(1)}%` });
    } else if (priceChangeH1 > 100) {
      score += 1;
      signals.push({ id: '11', name: '1h Price', trigger: `> +100%`, points: 1, risk: 'MEDIUM', value: `+${priceChangeH1.toFixed(1)}%` });
    } else {
      signals.push({ id: '11', name: '1h Price', trigger: 'OK', points: 0, risk: 'SAFE', value: `${priceChangeH1 >= 0 ? '+' : ''}${priceChangeH1.toFixed(1)}%` });
    }

    // ═══════════════════════════════════════════════════
    // NEW DYOR-INSPIRED SIGNALS
    // ═══════════════════════════════════════════════════

    // #12 Contract Safety (DYOR: contract-audit concept)
    if (isVerified === false) {
      score += 2;
      signals.push({ id: '12', name: 'Contract Safety', trigger: 'Unverified source', points: 2, risk: 'HIGH', value: 'Source code not verified' });
    } else if (isVerified === true && isProxy) {
      score += 1;
      signals.push({ id: '12', name: 'Contract Safety', trigger: 'Proxy contract', points: 1, risk: 'MEDIUM', value: 'Verified but upgradeable proxy' });
    } else if (isVerified === true) {
      signals.push({ id: '12', name: 'Contract Safety', trigger: 'Verified', points: 0, risk: 'SAFE', value: 'Source code verified' });
    } else {
      signals.push({ id: '12', name: 'Contract Safety', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Could not check verification' });
    }

    // #13 Token Age (DYOR: launchpad-origin-analysis concept)
    if (pairAgeHours !== null) {
      if (pairAgeHours < 1) {
        score += 3;
        signals.push({ id: '13', name: 'Token Age', trigger: `< 1 hour`, points: 3, risk: 'CRITICAL', value: `${Math.round(pairAgeHours * 60)}m old` });
      } else if (pairAgeHours < 24) {
        score += 2;
        signals.push({ id: '13', name: 'Token Age', trigger: `< 24 hours`, points: 2, risk: 'HIGH', value: `${Math.round(pairAgeHours)}h old` });
      } else if (pairAgeHours < 168) {
        score += 1;
        signals.push({ id: '13', name: 'Token Age', trigger: `< 7 days`, points: 1, risk: 'MEDIUM', value: `${Math.round(pairAgeHours / 24)}d old` });
      } else {
        signals.push({ id: '13', name: 'Token Age', trigger: 'OK', points: 0, risk: 'SAFE', value: `${Math.round(pairAgeHours / 24)}d old` });
      }
    } else {
      signals.push({ id: '13', name: 'Token Age', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'Unknown creation date' });
    }

    // #14 Volume/Liquidity Health (DYOR: dex-flow-analysis concept)
    if (liquidity > 0 && volume24h > 0) {
      const volLiqRatio = volume24h / liquidity;
      if (volLiqRatio > 10) {
        score += 2;
        signals.push({ id: '14', name: 'Vol/Liq Health', trigger: `> 10x`, points: 2, risk: 'HIGH', value: `${volLiqRatio.toFixed(1)}x — wash trading likely` });
      } else if (volLiqRatio > 5) {
        score += 1;
        signals.push({ id: '14', name: 'Vol/Liq Health', trigger: `> 5x`, points: 1, risk: 'MEDIUM', value: `${volLiqRatio.toFixed(1)}x — elevated` });
      } else {
        signals.push({ id: '14', name: 'Vol/Liq Health', trigger: 'OK', points: 0, risk: 'SAFE', value: `${volLiqRatio.toFixed(1)}x` });
      }
    } else {
      signals.push({ id: '14', name: 'Vol/Liq Health', trigger: 'N/A', points: 0, risk: 'UNKNOWN', value: 'No volume data' });
    }

    // Cap score at 22
    score = Math.min(score, 22);

    // Verdict (adjusted for 0-22 range)
    let verdict, action;
    if (score <= 3) { verdict = 'HOLD'; action = 'Safe to hold — all signals clear.'; }
    else if (score <= 7) { verdict = 'PARTIAL EXIT'; action = 'Consider selling 50% of your position.'; }
    else if (score <= 12) { verdict = 'MAJOR EXIT'; action = 'Sell 80%. Risk is significant.'; }
    else { verdict = 'FULL EXIT'; action = 'Sell everything. Maximum risk detected.'; }

    return res.status(200).json({
      success: true,
      token: {
        name: pair.baseToken?.name || 'Unknown',
        symbol: pair.baseToken?.symbol || '???',
        address: pair.baseToken?.address || address,
        chain: pair.chainId,
        priceUsd,
        fdv,
        pairAgeHours: pairAgeHours ? Math.round(pairAgeHours) : null,
        dex: pair.dexId,
        pairUrl: pair.url,
      },
      metrics: {
        liquidity,
        volume24h,
        buys24h,
        sells24h,
        buySellRatio,
        priceChangeH1,
        priceChangeH24,
        rugRatio,
        holderCount,
        topHolderPct,
        isVerified,
        hasOwner,
        isProxy,
        tokenType,
      },
      riskScore: score,
      maxScore: 22,
      verdict,
      action,
      signals,
      computedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'Failed to fetch token data', details: err.message });
  }
};

// ═══════════════════════════════════════════════════
// DATA FETCHERS
// ═══════════════════════════════════════════════════

async function fetchDexScreener(address, chain) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const data = await res.json();
  const pairs = data.pairs || [];
  return pairs.find(p => p.chainId === chain) || pairs[0] || null;
}

async function fetchBlockscout(address) {
  const BASE_URL = 'https://base.blockscout.com/api/v2';
  
  try {
    // Fetch address info (contract verification, proxy) + token info (holders) in parallel
    const [addrRes, tokenRes] = await Promise.allSettled([
      fetch(`${BASE_URL}/addresses/${address}`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${BASE_URL}/tokens/${address}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    let result = {
      holders: null,
      topHolderPct: null,
      isVerified: null,
      hasOwner: null,
      isProxy: null,
      tokenType: null,
      creationTxHash: null,
    };

    // Parse address info (has verification + proxy data)
    if (addrRes.status === 'fulfilled' && addrRes.value.ok) {
      const addrData = await addrRes.value.json();
      result.isVerified = addrData.is_verified ?? null;
      result.isProxy = addrData.implementation_address ? true : false;
      // For ownership: proxy contracts with implementation = upgradeable (risky)
      // Non-proxy verified contracts = can't determine owner from API alone
      result.hasOwner = addrData.implementation_address ? true : null;
    }

    // Parse token info (has holders count + type)
    if (tokenRes.status === 'fulfilled' && tokenRes.value.ok) {
      const tokenData = await tokenRes.value.json();
      result.holders = tokenData.holders_count ? parseInt(tokenData.holders_count) : null;
      result.tokenType = tokenData.type || null;
    }

    // Try to get top holder concentration from holders endpoint
    try {
      const holdersRes = await fetch(`${BASE_URL}/tokens/${address}/holders`, { 
        signal: AbortSignal.timeout(8000) 
      });
      if (holdersRes.ok) {
        const holdersData = await holdersRes.json();
        const items = holdersData.items || [];
        if (items.length >= 10) {
          const totalSupply = items[0]?.token?.total_supply 
            ? parseFloat(items[0].token.total_supply) / Math.pow(10, parseInt(items[0].token?.decimals || '18'))
            : null;
          if (totalSupply && totalSupply > 0) {
            const top10Value = items.slice(0, 10).reduce((sum, h) => {
              return sum + (parseFloat(h.value) || 0) / Math.pow(10, parseInt(h.token?.decimals || '18'));
            }, 0);
            result.topHolderPct = (top10Value / totalSupply) * 100;
          }
        }
      }
    } catch (e) { /* holders endpoint can be slow, skip */ }

    return result;
  } catch (err) {
    console.error('Blockscout fetch error:', err.message);
    return null;
  }
}

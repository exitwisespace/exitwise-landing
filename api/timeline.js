// ExitWise Event Timeline API — /api/timeline
// Pulls on-chain transaction history from Blockscout and returns a chronological timeline
// v2: Proper BUY/SELL/DEPLOY/LP_ADD classification, rate-limit retry, dedup

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, chain } = req.method === 'POST' ? req.body : req.query;

  if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
    return res.status(400).json({ success: false, error: 'Invalid contract address' });
  }

  const targetChain = chain || 'base';
  const BLOCKSCOUT = `https://${targetChain}.blockscout.com/api/v2`;

  try {
    // Fetch token transfers and address transactions in parallel
    const [transfersRes, txsRes] = await Promise.allSettled([
      blockscoutFetch(`${BLOCKSCOUT}/tokens/${address}/transfers?limit=20`),
      blockscoutFetch(`${BLOCKSCOUT}/addresses/${address}/transactions?limit=20`),
    ]);

    const events = [];
    const seenHashes = new Set();

    // Process token transfers
    if (transfersRes.status === 'fulfilled' && transfersRes.value.ok) {
      const data = await transfersRes.value.json();
      const transfers = data.items || [];

      for (const t of transfers) {
        const txHash = t.transaction_hash || t.tx_hash || '';
        const fromAddr = t.from?.hash || t.from || '';
        const toAddr = t.to?.hash || t.to || '';
        const timestamp = t.timestamp || t.block_timestamp || null;
        const tokenDecimals = parseInt(t.token?.decimals || '18');
        const rawValue = t.total?.value || t.value || '0';
        const value = parseFloat(rawValue) / Math.pow(10, tokenDecimals);

        // Classify: BUY / SELL / TRANSFER
        // Pair addresses typically have Uniswap V2/V3 factory patterns
        // We check if the from/to matches common DEX pair (router) addresses
        const toLower = toAddr.toLowerCase();
        const fromLower = fromAddr.toLowerCase();

        let type = 'TRANSFER';
        if (value > 0 && isLikelyPairOrRouter(toLower)) {
          type = 'BUY';   // tokens flowing into a pair/router = someone buying
        } else if (value > 0 && isLikelyPairOrRouter(fromLower)) {
          type = 'SELL';  // tokens flowing out of a pair/router = someone selling
        }

        const shortFrom = fromAddr ? `${fromAddr.slice(0, 6)}...${fromAddr.slice(-4)}` : '?';
        const shortTo = toAddr ? `${toAddr.slice(0, 6)}...${toAddr.slice(-4)}` : '?';

        let description;
        switch (type) {
          case 'BUY':
            description = `Buy: ${shortFrom} bought tokens via pair ${shortTo}`;
            break;
          case 'SELL':
            description = `Sell: ${shortFrom} sold tokens to ${shortTo}`;
            break;
          default:
            description = `Transfer: ${shortFrom} → ${shortTo}`;
        }

        if (!seenHashes.has(txHash)) {
          seenHashes.add(txHash);
        }

        events.push({
          time: timestamp ? new Date(timestamp).toISOString() : null,
          type,
          description,
          from: fromAddr,
          to: toAddr,
          value: value > 0 ? formatValue(value) : null,
          txHash,
        });
      }
    }

    // Process address transactions (contract interactions)
    if (txsRes.status === 'fulfilled' && txsRes.value.ok) {
      const data = await txsRes.value.json();
      const txs = data.items || [];

      for (const tx of txs) {
        const txHash = tx.hash || '';
        // Skip if we already processed this tx from token transfers
        if (seenHashes.has(txHash)) continue;
        seenHashes.add(txHash);

        const timestamp = tx.timestamp;
        const fromAddr = tx.from?.hash || '';
        const toAddr = tx.to?.hash || '';
        const ethValue = tx.value ? parseInt(tx.value) / 1e18 : 0;
        const methodId = tx.method || '0x';

        let type = 'TRANSFER';
        let description = '';

        const shortFrom = fromAddr ? `${fromAddr.slice(0, 6)}...${fromAddr.slice(-4)}` : '?';
        const shortTo = toAddr ? `${toAddr.slice(0, 6)}...${toAddr.slice(-4)}` : '?';

        // DEPLOY: method_id is '0x' (contract creation) and value > 0
        const isCreation = tx.transaction_types?.includes('contract_creation') || !!tx.created_contract;
        if (isCreation && (methodId === '0x' || methodId === '')) {
          type = 'DEPLOY';
          description = `Contract deployed by ${shortFrom}`;
        }
        // LP_ADD: ETH sent to a contract (non-transfer, likely adding liquidity)
        else if (ethValue > 0 && tx.to?.is_contract) {
          type = 'LP_ADD';
          description = `Liquidity added: ${ethValue.toFixed(4)} ETH from ${shortFrom} → ${shortTo}`;
        }
        // Default: TRANSFER
        else {
          description = `Tx: ${shortFrom} → ${shortTo}`;
        }

        events.push({
          time: timestamp ? new Date(timestamp).toISOString() : null,
          type,
          description,
          from: fromAddr,
          to: toAddr,
          value: ethValue > 0 ? `${ethValue.toFixed(4)} ETH` : null,
          txHash,
        });
      }
    }

    // Sort by timestamp descending (newest first)
    events.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return new Date(b.time) - new Date(a.time);
    });

    return res.status(200).json({
      success: true,
      events: events.slice(0, 30),
    });

  } catch (err) {
    console.error('Timeline error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Timeline fetch failed' });
  }
};

/**
 * Fetch from Blockscout with automatic retry on 429 rate limit.
 */
async function blockscoutFetch(url) {
  let res = await fetch(url, { signal: AbortSignal.timeout(10000) });

  // Retry once on 429 rate limit after a short backoff
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  }

  return res;
}

/**
 * Heuristic: does the address look like a DEX pair/router?
 * Matches known Uniswap/Base routers and common pair patterns.
 */
function isLikelyPairOrRouter(addr) {
  if (!addr) return false;
  const known = [
    '0x327df1e6de05895d2ab08513aadd9313fe505d86', // Uniswap Universal Router
    '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 Router
    '0x4752ba5dbc23f44d87826276bf6d7aae4c1c1e32', // BaseSwap Router
    '0x8909dc15e40173ff469d1f3a32108d42f2946523', // Uniswap V2 Router (Base)
    '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', // Uniswap V3 Router 2 (Base)
  ];
  return known.includes(addr.toLowerCase());
}

/**
 * Format large token values into human-readable strings.
 */
function formatValue(val) {
  if (val >= 1e9) return (val / 1e9).toFixed(2) + 'B';
  if (val >= 1e6) return (val / 1e6).toFixed(2) + 'M';
  if (val >= 1e3) return (val / 1e3).toFixed(2) + 'K';
  if (val >= 1) return val.toFixed(2);
  if (val >= 0.0001) return val.toFixed(6);
  return val.toExponential(2);
}

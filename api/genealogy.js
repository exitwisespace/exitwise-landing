// ExitWise Wallet Genealogy API — /api/genealogy
// Traces the funding chain of a token's deployer wallet

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

  try {
    // Step 1: Get the token contract info to find deployer
    const contractRes = await fetch(`${BLOCKSCOUT}/addresses/${address}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!contractRes.ok) {
      return res.status(404).json({ error: 'Contract not found on Blockscout' });
    }
    const contractData = await contractRes.json();
    const deployerAddr = contractData.creator_address_hash;

    if (!deployerAddr) {
      return res.status(200).json({
        success: true,
        chain: [],
        rugLinks: [],
        message: 'No deployer found for this contract',
      });
    }

    // Step 2: Build the funding chain (up to 3 hops)
    const fundingChain = [];
    const rugLinks = [];
    let currentAddr = deployerAddr;
    const visited = new Set();

    for (let hop = 0; hop < 3; hop++) {
      if (!currentAddr || visited.has(currentAddr.toLowerCase())) break;
      visited.add(currentAddr.toLowerCase());

      // Get address info
      const addrInfoRes = await fetch(`${BLOCKSCOUT}/addresses/${currentAddr}`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);

      let balance = null;
      let isContract = false;
      if (addrInfoRes && addrInfoRes.ok) {
        const addrInfo = await addrInfoRes.json();
        balance = addrInfo.coin_balance
          ? (parseInt(addrInfo.coin_balance) / 1e18).toFixed(4) + ' ETH'
          : null;
        isContract = addrInfo.is_contract || false;
      }

      const role = hop === 0 ? 'deployer' : hop === 1 ? 'funder' : 'origin';

      fundingChain.push({
        address: currentAddr,
        role,
        balance,
        isContract,
        fundedAt: null,
        txHash: null,
      });

      // Check for scam patterns
      const scamCheck = await checkScamPatterns(currentAddr, BLOCKSCOUT);
      if (scamCheck.flagged) {
        rugLinks.push({
          address: currentAddr,
          reason: scamCheck.reason,
          hop,
        });
      }

      // Find the first incoming ETH transfer (funding tx)
      const txsRes = await fetch(
        `${BLOCKSCOUT}/addresses/${currentAddr}/transactions?limit=50`,
        { signal: AbortSignal.timeout(10000) }
      ).catch(() => null);

      if (!txsRes || !txsRes.ok) break;
      const txsData = await txsRes.json();
      const txs = txsData.items || [];

      // Find first incoming ETH transfer (not from self, has value)
      let fundingTx = null;
      for (const tx of txs) {
        const from = tx.from?.hash?.toLowerCase();
        const to = tx.to?.hash?.toLowerCase();
        const value = parseInt(tx.value || '0');

        // Skip self-transfers and zero-value
        if (from === currentAddr.toLowerCase()) continue;
        if (to !== currentAddr.toLowerCase()) continue;
        if (value <= 0) continue;

        fundingTx = tx;
        break;
      }

      if (!fundingTx) break;

      // Update the current chain entry with funding info
      fundingChain[fundingChain.length - 1].fundedAt = fundingTx.timestamp || null;
      fundingChain[fundingChain.length - 1].txHash = fundingTx.hash || null;

      // Next hop: the funder address
      const funderAddr = fundingTx.from?.hash;
      if (!funderAddr) break;

      // Check if funder has contract creations (possible multi-deployer pattern)
      const funderTxsRes = await fetch(
        `${BLOCKSCOUT}/addresses/${funderAddr}/transactions?limit=20`,
        { signal: AbortSignal.timeout(10000) }
      ).catch(() => null);

      if (funderTxsRes && funderTxsRes.ok) {
        const funderTxsData = await funderTxsRes.json();
        const funderTxs = funderTxsData.items || [];
        const contractCreations = funderTxs.filter(
          (tx) =>
            tx.transaction_types?.includes('contract_creation') ||
            tx.created_contract
        );

        if (contractCreations.length > 0) {
          // Funder also deploys contracts — flag as suspicious
          rugLinks.push({
            address: funderAddr,
            reason: `Funder has ${contractCreations.length} contract creation(s) — possible multi-deployer`,
            hop: hop + 1,
          });
        }
      }

      currentAddr = funderAddr;
    }

    return res.status(200).json({
      success: true,
      address,
      chainId: targetChain,
      deployer: deployerAddr,
      chainDepth: fundingChain.length,
      chain: fundingChain,
      rugLinks: dedupRugLinks(rugLinks),
    });
  } catch (err) {
    console.error('Genealogy error:', err);
    return res.status(500).json({
      error: 'Genealogy trace failed',
      details: err.message,
    });
  }
};

// Check if an address matches known scam patterns
async function checkScamPatterns(address, BASE) {
  try {
    const addrRes = await fetch(`${BASE}/addresses/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!addrRes.ok) return { flagged: false };

    const addrData = await addrRes.json();

    // Check Blockscout reputation/tags
    if (addrData.is_scam) {
      return { flagged: true, reason: 'Address flagged as scam on Blockscout' };
    }

    if (addrData.is_banned) {
      return { flagged: true, reason: 'Address is banned' };
    }

    // Check public/private tags for scam keywords
    const tags = [
      ...(addrData.private_tags || []),
      ...(addrData.public_tags || []),
      ...(addrData.watchlist_names || []),
    ];
    const tagNames = tags.map((t) => (t.name || '').toLowerCase()).join(' ');
    const scamKeywords = ['scam', 'rug', 'phish', 'hack', 'exploit', 'drainer', 'fraud'];
    for (const kw of scamKeywords) {
      if (tagNames.includes(kw)) {
        return { flagged: true, reason: `Tagged as "${kw}"` };
      }
    }

    // Check if address is a known contract with suspicious patterns
    if (addrData.is_contract) {
      const scRes = await fetch(`${BASE}/smart-contracts/${address}`, {
        signal: AbortSignal.timeout(8000),
      }).catch(() => null);
      if (scRes && scRes.ok) {
        const scData = await scRes.json();
        if (scData.reputation === 'scam' || scData.reputation === 'spam') {
          return { flagged: true, reason: `Contract reputation: ${scData.reputation}` };
        }
      }
    }

    return { flagged: false };
  } catch (e) {
    return { flagged: false };
  }
}

// Deduplicate rug links by address
function dedupRugLinks(links) {
  const seen = new Map();
  for (const link of links) {
    const key = link.address.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, link);
    }
  }
  return Array.from(seen.values());
}

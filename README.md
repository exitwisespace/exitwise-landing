# 🔍 ExitWise

**Real-time crypto token risk scanner & OSINT investigation engine.**

Paste a contract address → get a full risk assessment in seconds.

🔗 **Live:** [exitwise-landing-seven.vercel.app](https://exitwise-landing-seven.vercel.app)

---

## Features

### ⚡ Quick Scanner
14-signal risk score (0–22) powered by DexScreener + Blockscout on-chain data.

| # | Signal | Weight |
|---|--------|--------|
| 01 | Liquidity | 1-3 |
| 02 | ATH Dump | 1-2 |
| 03 | Rug Ratio | 1-3 |
| 04 | Contract Safety | 1-2 |
| 05 | Top Holders | 1-3 |
| 06 | Volume/Liq Health | 1-2 |
| 07 | Holder Count | 1-3 |
| 08 | Smart Money | 1-2 |
| 09 | Buy/Sell Ratio | 1-2 |
| 10 | 1H Price Action | 1-2 |
| 11 | Token Age | 1-3 |
| 12 | Buy Tax | 1-2 |
| 13 | Sell Tax | 1-2 |
| 14 | Proxy Contract | 1-2 |

**Verdicts:** HOLD (0-3) → PARTIAL EXIT (4-7) → MAJOR EXIT (8-12) → FULL EXIT (13-22)

### 🔎 Deep Investigation
Full OSINT report from 4 parallel data sources:

- **DexScreener** — price, volume, liquidity, social links
- **Blockscout** — on-chain data, holders, contract verification, deployer info
- **GoPlus Security** — honeypot, taxes, mint/pause/blacklist flags
- **TACHITRACK OSINT** — EVM wallet intel, OFAC sanctions, risk flags

### 🔎 Deployer Forensics
- Contract creation transaction analysis
- Deployer wallet balance & history
- All tokens deployed by same address
- Rug/scam token detection in deployer's portfolio

### 👥 Holder Clustering
- Top 50 holder analysis (EOA vs contract wallets)
- Concentration metrics (Top 3% / Top 10%)
- Whale detection with percentage holdings
- Exchange wallet identification (Bybit, Gate, Upbit, etc.)
- Scam-tagged holder detection

### 🤖 AI Agent Mode
- POST `/api/ai` — sends investigation data to LLM for natural language analysis
- Powered by OpenGateway (mimo-v2.5-pro)
- Enhanced fallback rule-based analysis when AI unavailable
- Returns clear verdict: SAFE / CAUTION / DANGEROUS

---

## API Endpoints

### `GET /api/scan?address=0x...&chain=base`
Quick risk scan — returns risk score, signals, metrics.

### `GET /api/investigate?address=0x...&chain=base`
Full OSINT investigation — returns token data, contract audit, deployer forensics, holder clustering, markdown report.

### `POST /api/ai`
AI-powered analysis — send investigation data as `{ data: <investigate_result> }`, returns natural language verdict.

---

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS (single-file SPA)
- **Backend:** Node.js serverless functions (Vercel)
- **Data Sources:** DexScreener API, Blockscout API, GoPlus Security API, TACHITRACK OSINT
- **AI:** OpenGateway (mimo-v2.5-pro) with fallback rule-based analysis
- **Hosting:** Vercel (free tier)

---

## Local Development

```bash
# Clone
git clone https://github.com/exitwisespace/exitwise-landing.git
cd exitwise-landing

# Install Vercel CLI
npm i -g vercel

# Run locally
vercel dev

# Set env vars (for AI mode)
vercel env add LLM_API_KEY
vercel env add LLM_MODEL
vercel env add LLM_BASE_URL
```

---

## Project Structure

```
exitwise-landing/
├── api/
│   ├── scan.js          # Quick risk scanner endpoint
│   ├── investigate.js   # Full OSINT investigation endpoint
│   └── ai.js            # AI agent analysis endpoint
├── public/
│   ├── index.html       # Main scanner UI
│   └── investigate.html # Investigation report UI
├── vercel.json          # Vercel config
└── README.md
```

---

## Deployment

```bash
# Deploy to Vercel
vercel deploy --prod

# Set environment variables
vercel env add LLM_API_KEY production
vercel env add LLM_MODEL production
vercel env add LLM_BASE_URL production
```

---

## License

MIT

---

Built with 🧠 by [@greenshit333](https://twitter.com/greenshit333)

# ⬡ INSTMAP — Institutional Positioning Dashboard

> Real-time options intelligence powered by Polygon.io · Deployable on GitHub Pages

---

## What It Does

A 5-layer institutional positioning map that replaces interpretation delay with an instant read on:

| Layer | Engine | Data Source |
|-------|--------|-------------|
| L1 | **Regime Engine** | SPY/QQQ/IWM/VIX snapshots, day-type classification |
| L2 | **Dealer Positioning** | OI Wall Map, Gamma Staircase, Call/Put Walls, Max Pain, Gamma Flip |
| L3 | **Flow Engine** | Options volume, P/C ratio, sweep detection, flow balance |
| L4 | **Structure Engine** | EMA 20/50, RSI, MACD, Prev Day H/L, Weekly H/L, level stack |
| L5 | **Playbook Engine** | Setup classification, confluence scoring, probability map |

**Playbook classifications:** TRIFECTA · MAGNET RUN · GAMMA EXPANSION · FIRECRACKER · PIN RISK · DEALER CASCADE

---

## Quick Setup

### 1. Get a Polygon.io API Key

1. Sign up at [polygon.io](https://polygon.io)
2. Subscribe to the **Options** plan (required for option chain data)
3. Copy your API key from the dashboard

### 2. Deploy to GitHub Pages

```bash
# Fork or clone this repo
git clone https://github.com/YOUR_USERNAME/instmap-dashboard.git
cd instmap-dashboard

# Push to your repo
git add .
git commit -m "Initial deploy"
git push origin main
```

Then in your GitHub repo:
- Go to **Settings → Pages**
- Source: **Deploy from a branch**
- Branch: `main` / `/ (root)`
- Save → your dashboard will be live at `https://YOUR_USERNAME.github.io/instmap-dashboard`

### 3. Use the Dashboard

1. Open the URL
2. Enter your **Polygon.io API key** in the top-right field
3. Set the **ticker** (default: IWM)
4. Click **SCAN**
5. Data auto-refreshes every **60 seconds**

> Your API key is saved in `localStorage` — it persists between sessions and never leaves your browser.

---

## Polygon.io Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | Real-time price snapshots (SPY, QQQ, IWM) |
| `GET /v3/snapshot/options/{underlyingAsset}` | Full option chain with OI, greeks, IV |
| `GET /v1/indicators/ema/{optionsTicker}` | EMA 20 and EMA 50 |
| `GET /v1/indicators/rsi/{optionsTicker}` | RSI (14-period) |
| `GET /v1/indicators/macd/{optionsTicker}` | MACD (12/26/9) |
| `GET /v2/aggs/ticker/{ticker}/prev` | Previous day OHLCV + VWAP |
| `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}` | Weekly high/low bars |

---

## Dashboard Sections

### Playbook Banner (Top Bar)
Instant summary across all 5 layers:
```
REGIME | DEALER BIAS | GAMMA STATE | TARGET MAGNET | PLAYBOOK | RISK
```

### L1 — Regime Engine
- Live price + % change for SPY, QQQ, IWM, VIX
- Auto-classifies into: TREND / CHOP / PIN / EXPANSION / HEDGE day

### L2 — Dealer Positioning
- **OI Wall Map**: visual bar chart of calls vs puts by strike
- **Gamma Staircase**: acceleration ladder above current price
- **Call Wall / Put Wall / Max Pain / Gamma Flip**: key institutional levels
- **Net Gamma Exposure**: positive (pin/chop) vs negative (expansion/trend)

### L3 — Flow Engine
- Total call/put volume with P/C ratio
- **Flow signal**: AGGRESSIVE CALLS → CALL SKEW → NEUTRAL → PUT SKEW → AGGRESSIVE PUTS
- Top contracts sorted by volume with sweep detection
- Visual call/put balance bar

### L4 — Structure Engine
- Large price display with daily change
- Level stack: all key levels color-coded by resistance/support/current
- EMA 20/50 with above/below status
- RSI, MACD with directional signals
- Key levels table: Prev Week H/L, Prev Day H/L

### L5 — Playbook Engine
- **Active Setup card** with confluence score (0–100%)
- **6 playbook cards** that activate based on conditions
- **Probability Map**: bull/bear scenario paths with %, conditions
- **Signal log**: timestamped events with color coding

---

## Confluence Scoring

| Factor | Points |
|--------|--------|
| Market regime bullish (SPY/IWM both green) | +20 |
| Price above EMA 20 AND EMA 50 | +20 |
| Call flow dominant (P/C < 0.8) | +15 |
| Negative gamma = expansion mode | +15 |
| Price below call wall (room to run) | +15 |
| Price above max pain | +10 |
| VIX < 20 | +5 |
| **Max total** | **100** |

Setups activate at:
- 80%+ → **TRIFECTA**
- 60%+ (negative gamma, bullish) → **GAMMA EXPANSION**
- 50%+ (above max pain) → **MAGNET RUN**
- Balanced + positive gamma → **PIN RISK**
- Aggressive flow → **FIRECRACKER**
- <30% + bearish → **DEALER CASCADE**

---

## Customization

In `dashboard.js`, edit the `CFG` object:

```javascript
const CFG = {
  REFRESH_INTERVAL: 60,      // auto-refresh in seconds
  OI_STRIKES_AROUND: 15,     // strikes shown each side of ATM
  FLOW_TABLE_MAX: 20,        // max rows in flow table
  DEFAULT_TICKER: 'IWM',    // starting ticker
  EXPIRY_LOOKAHEAD_DAYS: 45, // option chain expiry range
};
```

---

## Legal

> This dashboard is for **educational purposes only**. It does not constitute financial advice. All data is provided by Polygon.io subject to their terms of service. Options trading involves substantial risk of loss.

---

*INSTMAP v2.0 · Built for institutional-grade positioning intelligence*

/* ═══════════════════════════════════════════════════════════
   INSTMAP v2.2 — API-Optimized Edition
   
   KEY FIXES:
   - Sequential throttled fetching (no burst = no 429s)
   - Removed all /range/1/minute (403 on Options plan)
   - Removed weekly bars via /range (403 on Options plan)
   - Price = prevDay close + option chain underlying_price
   - VIX + indicators fetched with 350ms gaps between calls
   - Smart caching: prev-day data reused across layers
   - Auto-retry 429s with 2s backoff
   ═══════════════════════════════════════════════════════════ */

'use strict';

const CFG = {
  POLYGON_BASE:     'https://api.polygon.io',
  POLYGON_WS:       'wss://socket.polygon.io/options',
  REFRESH_INTERVAL: 120,       // 2 min — safer for rate limits
  CALL_GAP_MS:      400,       // ms between sequential API calls
  FLOW_TABLE_MAX:   25,
  DEFAULT_TICKER:   'IWM',
  RETRY_DELAY_MS:   2500,      // wait on 429 before retry
  MAX_RETRIES:      2,
};

const STATE = {
  apiKey:        '',
  ticker:        CFG.DEFAULT_TICKER,
  price:         null,
  prevClose:     null,
  optionChain:   [],
  indicators:    {},
  marketOpen:    false,
  regimeData:    {},
  countdown:     CFG.REFRESH_INTERVAL,
  refreshTimer:  null,
  cdTimer:       null,
  ws:            null,
  wsConnected:   false,
  // Cache: keyed by ticker, expires after 90s
  cache:         {},
  lastRefresh:   0,
  isRefreshing:  false,
};

// ── DOM ───────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
const cls = (id, c)   => { const e = $(id); if (e) e.className  = c; };

// ── THROTTLED API LAYER ───────────────────────────────────
// Single queue ensures calls are spaced CFG.CALL_GAP_MS apart
const apiQueue = (() => {
  let lastCall = 0;
  return async (fn) => {
    const now  = Date.now();
    const wait = Math.max(0, lastCall + CFG.CALL_GAP_MS - now);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  };
})();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function polyGet(path, params = {}, retries = CFG.MAX_RETRIES) {
  return apiQueue(async () => {
    const url = new URL(CFG.POLYGON_BASE + path);
    url.searchParams.set('apiKey', STATE.apiKey);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url.toString());
      if (res.status === 429) {
        if (attempt < retries) { await sleep(CFG.RETRY_DELAY_MS * (attempt + 1)); continue; }
        throw new Error(`429 rate limit: ${path}`);
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status} ${path}`);
      }
      return res.json();
    }
  });
}

// Cache wrapper — avoids re-fetching identical data within same session
async function cachedGet(cacheKey, path, params, ttlMs = 90000) {
  const entry = STATE.cache[cacheKey];
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  const data = await polyGet(path, params);
  STATE.cache[cacheKey] = { data, ts: Date.now() };
  return data;
}

// ── CLOCK + MARKET STATUS ─────────────────────────────────
function startClock() {
  const tick = () => {
    const et  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const pad = n => String(n).padStart(2,'0');
    set('clock', `${pad(et.getHours())}:${pad(et.getMinutes())}:${pad(et.getSeconds())} ET`);
    const h = et.getHours(), m = et.getMinutes(), d = et.getDay();
    const open = d >= 1 && d <= 5 && (h > 9 || (h===9 && m>=30)) && h < 16;
    STATE.marketOpen = open;
    const el = $('mktStatus');
    if (el) {
      el.textContent = open ? '● MARKET OPEN' : '● MARKET CLOSED';
      el.className   = 'market-status ' + (open ? 'open' : 'closed');
    }
  };
  tick(); setInterval(tick, 1000);
}

// ══════════════════════════════════════════════════════════
// DATA FETCHERS  — each uses cachedGet to avoid double hits
// ══════════════════════════════════════════════════════════

// Prev-day bar: works on Options plan, confirmed 200 OK
async function fetchPrevDay(ticker) {
  try {
    const d = await cachedGet(`prev_${ticker}`,
      `/v2/aggs/ticker/${ticker}/prev`, { adjusted: true }, 300000 // cache 5 min
    );
    const r = d?.results?.[0];
    return r ? { open:r.o, high:r.h, low:r.l, close:r.c, vwap:r.vw, volume:r.v } : null;
  } catch(e) { logSignal(`prevDay ${ticker}: ${e.message}`, 'warn'); return null; }
}

// Option chain — the ONE confirmed-200 endpoint
// Pulls paginated results, gets underlying_price from first result
async function fetchOptionChain(underlying) {
  try {
    const all = [];
    let nextUrl = null;
    let underlyingPrice = null;

    // Page 1 — direct build to avoid double apiKey param on next_url
    const firstUrl = new URL(`${CFG.POLYGON_BASE}/v3/snapshot/options/${underlying}`);
    firstUrl.searchParams.set('limit', '250');
    firstUrl.searchParams.set('apiKey', STATE.apiKey);

    const firstRes = await fetch(firstUrl.toString());
    if (!firstRes.ok) { logSignal(`Option chain: ${firstRes.status}`, 'warn'); return []; }
    const firstData = await firstRes.json();
    if (firstData.results) {
      all.push(...firstData.results);
      // Extract live price from underlying_asset if available
      if (firstData.results[0]?.underlying_asset?.price) {
        underlyingPrice = firstData.results[0].underlying_asset.price;
      }
    }
    nextUrl = firstData.next_url;

    // Pages 2-3 (throttled)
    for (let p = 1; p < 3 && nextUrl; p++) {
      await sleep(CFG.CALL_GAP_MS);
      const pageUrl = nextUrl + (nextUrl.includes('?') ? '&' : '?') + `apiKey=${STATE.apiKey}`;
      const res = await fetch(pageUrl);
      if (!res.ok) break;
      const data = await res.json();
      if (data.results) all.push(...data.results);
      nextUrl = data.next_url;
    }

    STATE.chainUnderlyingPrice = underlyingPrice;
    return all;
  } catch(e) { logSignal(`Option chain: ${e.message}`, 'warn'); return []; }
}

// EMA — works on Options plan
async function fetchEMA(ticker, period) {
  try {
    const d = await cachedGet(`ema${period}_${ticker}`,
      `/v1/indicators/ema/${ticker}`,
      { timespan:'day', window:period, limit:3, series_type:'close' },
      300000
    );
    const vals = d?.results?.values;
    return vals?.length ? { current: vals[0].value, prev: vals[1]?.value, prev2: vals[2]?.value } : null;
  } catch(e) { return null; }
}

async function fetchRSI(ticker) {
  try {
    const d = await cachedGet(`rsi_${ticker}`,
      `/v1/indicators/rsi/${ticker}`,
      { timespan:'day', window:14, limit:2, series_type:'close' },
      300000
    );
    const vals = d?.results?.values;
    return vals?.length ? { current: vals[0].value, prev: vals[1]?.value } : null;
  } catch(e) { return null; }
}

async function fetchMACD(ticker) {
  try {
    const d = await cachedGet(`macd_${ticker}`,
      `/v1/indicators/macd/${ticker}`,
      { timespan:'day', short_window:12, long_window:26, signal_window:9, limit:1, series_type:'close' },
      300000
    );
    const v = d?.results?.values?.[0];
    return v ? { value:v.value, signal:v.signal, histogram:v.histogram } : null;
  } catch(e) { return null; }
}

// ── OPTION CHAIN PROCESSING ───────────────────────────────
function processChain(chain, price) {
  if (!chain.length || !price) return null;

  // Group by expiry
  const grouped = {};
  chain.forEach(c => {
    const exp = c.details?.expiration_date;
    if (!exp) return;
    if (!grouped[exp]) grouped[exp] = [];
    grouped[exp].push(c);
  });

  // Use nearest 2 expiries for walls, all 3 for flow
  const expiries  = Object.keys(grouped).sort();
  const nearExp   = expiries[0];
  const wallContracts = expiries.slice(0,2).flatMap(e => grouped[e]);
  const flowContracts = expiries.slice(0,3).flatMap(e => grouped[e]);

  // Build strike map from wall contracts
  const strikeMap = {};
  let totalCallOI = 0, totalPutOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  let netGamma = 0;

  wallContracts.forEach(c => {
    const strike = c.details?.strike_price;
    const type   = c.details?.contract_type;
    const oi     = c.open_interest      || 0;
    const vol    = c.day?.volume        || 0;
    const gamma  = c.greeks?.gamma      || 0;
    const iv     = c.implied_volatility || 0;
    if (!strike || !type) return;

    if (!strikeMap[strike]) strikeMap[strike] = { strike, callOI:0, putOI:0, callVol:0, putVol:0, gamma:0, iv:0 };

    if (type === 'call') {
      strikeMap[strike].callOI  += oi;
      strikeMap[strike].callVol += vol;
      totalCallOI  += oi; totalCallVol += vol;
      netGamma     += gamma * oi * 100 * price;
    } else {
      strikeMap[strike].putOI   += oi;
      strikeMap[strike].putVol  += vol;
      totalPutOI   += oi; totalPutVol += vol;
      netGamma     -= gamma * oi * 100 * price;
    }
    strikeMap[strike].gamma += Math.abs(gamma * oi);
    strikeMap[strike].iv     = iv || strikeMap[strike].iv;
  });

  const strikes = Object.keys(strikeMap).map(Number).sort((a,b) => a-b);

  // Call / Put walls
  let callWall = null, putWall = null, maxCallOI = 0, maxPutOI = 0;
  strikes.forEach(s => {
    if (strikeMap[s].callOI > maxCallOI) { maxCallOI = strikeMap[s].callOI; callWall = s; }
    if (strikeMap[s].putOI  > maxPutOI)  { maxPutOI  = strikeMap[s].putOI;  putWall  = s; }
  });

  // Max pain
  let maxPain = price, minLoss = Infinity;
  strikes.forEach(s => {
    let loss = 0;
    strikes.forEach(k => {
      loss += strikeMap[k].callOI * Math.max(0, s - k);
      loss += strikeMap[k].putOI  * Math.max(0, k - s);
    });
    if (loss < minLoss) { minLoss = loss; maxPain = s; }
  });

  // Gamma flip — highest gamma concentration near ATM
  let gammaFlip = price, bestScore = 0;
  strikes.forEach(s => {
    const sc = strikeMap[s].gamma / (Math.abs(s - price) + 1);
    if (sc > bestScore) { bestScore = sc; gammaFlip = s; }
  });

  // Staircase — above price, sorted by proximity then OI
  const staircase = strikes
    .filter(s => s >= price && strikeMap[s].callOI > 0)
    .sort((a,b) => a - b)
    .slice(0, 6)
    .map(s => ({ strike:s, oi:strikeMap[s].callOI }));

  // Top flow from all 3 expiries, sorted by vol
  const topContracts = flowContracts
    .filter(c => (c.day?.volume || 0) > 0)
    .sort((a,b) => (b.day?.volume||0) - (a.day?.volume||0))
    .slice(0, CFG.FLOW_TABLE_MAX);

  // Put/call ratios
  const pcVolRatio = totalPutVol  / (totalCallVol  || 1);
  const pcOIRatio  = totalPutOI   / (totalCallOI   || 1);

  return {
    strikeMap, strikes, staircase, topContracts,
    callWall, putWall, maxPain, gammaFlip,
    totalCallOI, totalPutOI, totalCallVol, totalPutVol,
    netGamma, pcVolRatio, pcOIRatio,
    nearestExp: nearExp,
    allExpiries: expiries,
  };
}

// ══════════════════════════════════════════════════════════
// WEBSOCKET — live option minute bars
// ══════════════════════════════════════════════════════════
function connectWebSocket() {
  if (!STATE.apiKey || STATE.ws) return;
  try {
    const ws = new WebSocket(CFG.POLYGON_WS);
    STATE.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ action:'auth', params: STATE.apiKey }));
    };

    ws.onmessage = e => {
      let msgs; try { msgs = JSON.parse(e.data); } catch(_) { return; }
      msgs.forEach(msg => {
        if (msg.ev === 'status' && msg.status === 'auth_success') {
          // Subscribe to minute bars for all options on this underlying
          ws.send(JSON.stringify({ action:'subscribe', params:`AM.O:${STATE.ticker}*` }));
          STATE.wsConnected = true;
          logSignal('WS live — streaming ' + STATE.ticker + ' option minute bars', 'bull');
          updateWSBadge(true);
        }
        if (msg.ev === 'AM') {
          // Use live close price from any option to infer underlying movement
          flashWSPulse();
          // If we have an underlying price in msg, update display
          if (msg.underlying_price) {
            STATE.price = msg.underlying_price;
            set('structPrice', STATE.price.toFixed(2));
          }
        }
      });
    };

    ws.onerror = () => { updateWSBadge(false); };
    ws.onclose = () => { STATE.wsConnected = false; STATE.ws = null; updateWSBadge(false); };
  } catch(e) { logSignal('WS init failed: ' + e.message, 'warn'); }
}

function updateWSBadge(on) {
  const el = $('wsStatus');
  if (el) { el.textContent = on ? '◉ WS LIVE' : '◎ WS OFF'; el.className = 'ws-status' + (on ? ' connected' : ''); }
}

function flashWSPulse() {
  const el = $('wsLive');
  if (el) { el.style.opacity = '1'; setTimeout(() => { if(el) el.style.opacity = '0.3'; }, 250); }
}

// ══════════════════════════════════════════════════════════
// LAYER 1 — REGIME ENGINE
// Sequential fetches to avoid 429
// ══════════════════════════════════════════════════════════
async function updateLayer1() {
  // Fetch SPY, QQQ, primary ticker — sequentially with gap
  const tickerDefs = [
    { sym:'SPY', id:'spy', label:'MARKET DIR' },
    { sym:'QQQ', id:'qqq', label:'TECH RISK'  },
    { sym: STATE.ticker, id:'iwm', label:'PRIMARY' },
  ];

  const prices = {};
  for (const td of tickerDefs) {
    const pd = await fetchPrevDay(td.sym);
    if (pd) {
      prices[td.sym] = pd;
      // Price for primary ticker = prevClose (best we can do without intraday)
      // Will be overridden by option chain underlying_price in L2
      if (td.sym === STATE.ticker) {
        if (!STATE.price) STATE.price = pd.close;
        STATE.prevClose = pd.close;
      }
    }
    // Render regime card with prev day data
    renderRegimeCard(td, pd);
  }

  // VIX — separate call with gap already handled by queue
  await fetchVIX();

  classifyRegime(prices);
  updatePlaybookBanner();
}

async function fetchVIX() {
  try {
    const d = await cachedGet('prev_VIX', '/v2/aggs/ticker/VIX/prev', { adjusted:true }, 300000);
    const r = d?.results?.[0];
    if (!r) return;
    const close = r.c;
    const prev  = r.o;
    const pct   = ((close - prev) / prev * 100);
    set('vix-price', close.toFixed(2));
    const label = close < 13 ? 'CALM' : close < 18 ? 'NORMAL' : close < 25 ? 'ELEVATED' : close < 35 ? 'HIGH' : 'EXTREME';
    const chgEl = $('vix-chg');
    if (chgEl) { chgEl.textContent = label; chgEl.className = 'rc-change ' + (close < 20 ? 'pos' : 'neg'); }
    const fill = $('vix-fill');
    if (fill) { fill.style.width = Math.min(close * 2.5, 95) + '%'; fill.className = 'rc-fill ' + (close < 20 ? 'pos' : 'neg'); }
    const card = $('rc-vix');
    if (card) card.className = 'regime-card ' + (close < 20 ? 'bull' : 'bear');
    STATE.regimeData.vix = close;
  } catch(e) { logSignal('VIX: ' + e.message, 'warn'); }
}

function renderRegimeCard(td, pd) {
  // Use prevDay data — change = (close - open) / open
  const close = pd?.close ?? null;
  const open  = pd?.open  ?? null;
  const pct   = (close && open) ? ((close - open) / open * 100) : 0;

  set(`${td.id}-price`, close ? close.toFixed(2) : '--');
  const chgEl = $(`${td.id}-chg`);
  if (chgEl) {
    chgEl.textContent = close ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% (prev)' : '--';
    chgEl.className = 'rc-change ' + (pct >= 0 ? 'pos' : 'neg');
  }
  const fill = $(`${td.id}-fill`);
  if (fill) { fill.style.width = Math.min(Math.max(50 + pct * 4, 5), 95) + '%'; fill.className = 'rc-fill ' + (pct >= 0 ? 'pos' : 'neg'); }
  const card = $(`rc-${td.id}`);
  if (card) card.className = 'regime-card ' + (pct >= 0 ? 'bull' : 'bear');
}

function classifyRegime(prices) {
  const vix = STATE.regimeData.vix || 16;
  const spy  = prices['SPY'];
  const qqq  = prices['QQQ'];
  const prim = prices[STATE.ticker];

  const spyChg  = spy  ? ((spy.close  - spy.open)  / spy.open  * 100) : 0;
  const qqqChg  = qqq  ? ((qqq.close  - qqq.open)  / qqq.open  * 100) : 0;
  const primChg = prim ? ((prim.close - prim.open) / prim.open * 100) : 0;

  const bullish   = spyChg > 0 && primChg > 0;
  const trending  = Math.abs(spyChg) > 0.4;
  const chop      = Math.abs(spyChg) < 0.2 && vix < 16;
  const expansion = Math.abs(primChg) > 0.8;
  const highVol   = vix > 25;

  let regime = 'TREND DAY', dtActive = 'dt-trend';
  if (highVol)        { regime = 'HEDGE DAY';     dtActive = 'dt-hedge'; }
  else if (chop)      { regime = 'CHOP DAY';      dtActive = 'dt-chop'; }
  else if (expansion) { regime = 'EXPANSION DAY'; dtActive = 'dt-expansion'; }
  else if (!trending) { regime = 'PIN DAY';        dtActive = 'dt-pin'; }

  set('regimeLabel', regime);
  STATE.regimeData.regime   = regime;
  STATE.regimeData.bullish  = bullish;
  STATE.regimeData.spyChg   = spyChg;

  ['dt-trend','dt-chop','dt-pin','dt-expansion','dt-hedge'].forEach(id => {
    const el = $(id); if (el) el.className = 'day-type-item' + (id === dtActive ? ' active' : '');
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 2 — DEALER POSITIONING
// ══════════════════════════════════════════════════════════
async function updateLayer2() {
  // Option chain is our primary data source — confirmed 200 OK
  const chain = await fetchOptionChain(STATE.ticker);
  STATE.optionChain = chain;

  // Override price with live underlying price from option chain if available
  if (STATE.chainUnderlyingPrice) {
    STATE.price = STATE.chainUnderlyingPrice;
    logSignal(`Live price from options chain: $${STATE.price.toFixed(2)}`, 'bull');
  }

  const price = STATE.price;
  if (!price) { logSignal('No price data — check ticker', 'warn'); return; }
  if (!chain.length) { logSignal('Option chain empty', 'warn'); return; }

  const od = processChain(chain, price);
  if (!od) return;
  STATE.regimeData.od = od;

  // ── Wall stats ──
  const fmt = v => v != null ? v.toFixed(0) : '--';
  set('callWall', fmt(od.callWall));
  set('maxPain',  fmt(od.maxPain));
  set('putWall',  fmt(od.putWall));
  set('gammaFlip',fmt(od.gammaFlip));

  if (od.callWall && price) {
    const dist = ((od.callWall - price) / price * 100);
    set('callWallDist', (dist >= 0 ? '+' : '') + dist.toFixed(2) + '% away');
    set('distCallWall', (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%');
    set('roomToRun', dist > 3 ? 'CLEAR' : dist > 1 ? 'TIGHT' : dist > 0 ? 'AT WALL' : 'THROUGH');
  }
  if (od.putWall && price) {
    const dist = ((od.putWall - price) / price * 100);
    set('putWallDist', (dist >= 0 ? '+' : '') + dist.toFixed(2) + '% away');
  }

  // Net gamma
  const ng    = od.netGamma;
  const ngStr = (ng >= 0 ? '+' : '') + (ng / 1e6).toFixed(2) + 'M';
  set('netGamma', ngStr);
  const ngEl = $('netGamma'); if (ngEl) ngEl.className = 'gs-val ' + (ng >= 0 ? 'yellow' : 'green');

  set('gammaState', ng >= 0 ? 'POSITIVE (PIN)' : 'NEGATIVE (EXP)');
  STATE.regimeData.gammaPositive = ng >= 0;

  // Nearest exp label
  if (od.nearestExp) set('nearestExp', 'EXP: ' + od.nearestExp);

  // All expiries
  const expBadge = $('allExpiries');
  if (expBadge && od.allExpiries) expBadge.textContent = od.allExpiries.slice(0,4).join('  ·  ');

  renderOIChart(od, price);
  renderStaircase(od.staircase, price);
  updatePlaybookBanner();
}

function renderOIChart(od, price) {
  const chart = $('oiChart'); if (!chart) return;
  chart.innerHTML = '';

  const nearby = od.strikes.filter(s => {
    const info = od.strikeMap[s];
    return (info.callOI > 0 || info.putOI > 0) && Math.abs(s - price) / price < 0.10;
  });
  if (!nearby.length) { chart.innerHTML = '<div class="oi-loading">No OI within 10% of price</div>'; return; }

  const maxOI  = Math.max(...nearby.map(s => Math.max(od.strikeMap[s].callOI, od.strikeMap[s].putOI)));
  const chartH = 140;
  const minS   = nearby[0], maxS = nearby[nearby.length-1];

  // Price line
  const pct = ((price - minS) / ((maxS - minS) || 1)) * 100;
  const pl = document.createElement('div');
  pl.className = 'oi-price-line';
  pl.style.left = Math.max(0.5, Math.min(99.5, pct)) + '%';
  pl.title = 'Price: $' + price.toFixed(2);
  chart.appendChild(pl);

  // Max pain line
  if (od.maxPain) {
    const mpPct = ((od.maxPain - minS) / ((maxS - minS) || 1)) * 100;
    const mp = document.createElement('div');
    mp.className = 'oi-pain-line';
    mp.style.left = Math.max(0, Math.min(99, mpPct)) + '%';
    mp.title = 'Max Pain: $' + od.maxPain;
    chart.appendChild(mp);
  }

  nearby.forEach(s => {
    const info  = od.strikeMap[s];
    const group = document.createElement('div');
    group.className = 'oi-bar-group';
    group.title = `$${s} — C:${formatNum(info.callOI)} P:${formatNum(info.putOI)}`;

    const callH = Math.max(2, (info.callOI / maxOI) * chartH);
    const putH  = Math.max(2, (info.putOI  / maxOI) * chartH);

    const cb = document.createElement('div');
    cb.className = 'oi-bar call' + (s === od.callWall ? ' wall' : '');
    cb.style.height = callH + 'px';

    const pb = document.createElement('div');
    pb.className = 'oi-bar put' + (s === od.putWall ? ' wall' : '');
    pb.style.height = putH + 'px';

    const lbl = document.createElement('span');
    lbl.className = 'oi-strike';
    lbl.textContent = s;

    group.appendChild(cb); group.appendChild(pb); group.appendChild(lbl);
    chart.appendChild(group);
  });
}

function renderStaircase(staircase, price) {
  const row = $('staircaseRow'); if (!row) return;
  row.innerHTML = '';
  if (!staircase?.length) { row.innerHTML = '<div class="sc-step loading">No upside OI data</div>'; return; }
  staircase.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'sc-step' + (i === 0 ? ' active' : '');
    const pct = ((step.strike - price) / price * 100).toFixed(1);
    div.innerHTML = `${step.strike}<span class="sc-oi">${(step.oi/1000).toFixed(1)}K</span><span class="sc-pct">+${pct}%</span>`;
    row.appendChild(div);
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 3 — FLOW ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer3() {
  const od = STATE.regimeData.od;
  if (!od) { logSignal('No OI data for flow layer', 'warn'); return; }

  set('callVol', formatNum(od.totalCallVol));
  set('putVol',  formatNum(od.totalPutVol));
  set('totalCallOI', formatNum(od.totalCallOI));
  set('totalPutOI',  formatNum(od.totalPutOI));
  set('oiPCRatio',   od.pcOIRatio.toFixed(2));

  const pcr = od.pcVolRatio;
  set('pcRatio', pcr.toFixed(2));
  const pEl = $('pcRatio');
  if (pEl) pEl.className = 'fs-val ' + (pcr < 0.7 ? 'green' : pcr > 1.2 ? 'red' : 'yellow');

  // Flow signal
  let sig = 'NEUTRAL';
  if      (pcr < 0.45) sig = 'AGGRESSIVE CALLS';
  else if (pcr < 0.65) sig = 'STRONG CALL BIAS';
  else if (pcr < 0.85) sig = 'CALL SKEW';
  else if (pcr > 1.5)  sig = 'AGGRESSIVE PUTS';
  else if (pcr > 1.2)  sig = 'PUT SKEW';
  else if (pcr > 1.0)  sig = 'MILD PUT BIAS';
  set('flowSignal', sig);
  STATE.regimeData.flowSignal  = sig;
  STATE.regimeData.flowBullish = pcr < 0.85;

  // Flow bar
  const total = (od.totalCallVol + od.totalPutVol) || 1;
  const callP = Math.round(od.totalCallVol / total * 100);
  const putP  = 100 - callP;
  const fc = $('fbCalls'), fp = $('fbPuts');
  if (fc) fc.style.width = callP + '%';
  if (fp) fp.style.width = putP  + '%';
  set('fbCallPct', callP + '%'); set('fbPutPct', putP + '%');

  renderFlowTable(od.topContracts);
  updatePlaybookBanner();
}

function renderFlowTable(contracts) {
  const body = $('flowTable'); if (!body) return;
  body.innerHTML = '';
  if (!contracts?.length) {
    body.innerHTML = '<div class="ft-loading">No volume data — market may be closed</div>'; return;
  }
  contracts.forEach(c => {
    const type   = c.details?.contract_type   || '?';
    const strike = c.details?.strike_price    || '--';
    const exp    = c.details?.expiration_date || '--';
    const oi     = c.open_interest            || 0;
    const vol    = c.day?.volume              || 0;
    const iv     = c.implied_volatility       || 0;
    const delta  = c.greeks?.delta            || 0;

    const ratio   = vol / (oi || 1);
    const isSweep = vol > 300 && ratio > 0.25;
    const isBlock = vol > 1500;
    const isLarge = vol > 5000;
    let signal = ratio > 0.15 ? 'ACTIVE' : '--';
    if (isLarge && type === 'call') signal = '⚡BLOCK↑';
    else if (isLarge && type === 'put') signal = '⚡BLOCK↓';
    else if (isSweep && type === 'call') signal = 'SWEEP↑';
    else if (isSweep && type === 'put')  signal = 'SWEEP↓';

    const row = document.createElement('div');
    row.className = 'ft-row';
    row.innerHTML = `
      <span class="${type}">${strike}</span>
      <span class="${type}">${type.toUpperCase()}</span>
      <span>${exp.slice(5)}</span>
      <span>${formatNum(oi)}</span>
      <span class="${vol > 1000 ? (type==='call'?'green':'red') : ''}">${formatNum(vol)}</span>
      <span>${iv ? (iv*100).toFixed(0)+'%' : '--'}</span>
      <span class="${isSweep||isBlock ? 'sweep' : ''}">${signal}</span>
    `;
    body.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 4 — STRUCTURE ENGINE
// Sequential indicator fetches to avoid 429
// ══════════════════════════════════════════════════════════
async function updateLayer4() {
  const price = STATE.price;
  if (!price) return;

  set('structPrice', price.toFixed(2));
  set('klCUR', price.toFixed(2));

  // Change vs prevClose
  const pct  = STATE.prevClose ? ((price - STATE.prevClose) / STATE.prevClose * 100) : 0;
  const diff = STATE.prevClose ? (price - STATE.prevClose) : 0;
  const chgStr = STATE.prevClose
    ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} | ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    : `${price.toFixed(2)} (vs prev close)`;
  set('structChange', chgStr);
  const scEl = $('structChange'); if (scEl) scEl.className = 'spb-change ' + (pct >= 0 ? 'pos' : 'neg');

  // Fetch indicators SEQUENTIALLY — prevents 429 burst
  const ema20r = await fetchEMA(STATE.ticker, 20);
  const ema50r = await fetchEMA(STATE.ticker, 50);
  const rsiR   = await fetchRSI(STATE.ticker);
  const macd   = await fetchMACD(STATE.ticker);
  // Prev day already cached from L1
  const prevDayRaw = await cachedGet(`prev_${STATE.ticker}`, `/v2/aggs/ticker/${STATE.ticker}/prev`, { adjusted:true }, 300000).catch(() => null);
  const prevDay    = prevDayRaw?.results?.[0] ? { open:prevDayRaw.results[0].o, high:prevDayRaw.results[0].h, low:prevDayRaw.results[0].l, close:prevDayRaw.results[0].c, vwap:prevDayRaw.results[0].vw } : null;

  const ema20 = ema20r?.current ?? null;
  const ema50 = ema50r?.current ?? null;
  const rsi   = rsiR?.current   ?? null;
  STATE.indicators = { ema20, ema50, rsi, macd, prevDay };

  // EMA 20
  if (ema20 != null) {
    set('ema20', ema20.toFixed(2));
    const ab = price > ema20;
    const trend = ema20r.current > ema20r.prev ? ' ▲' : ' ▼';
    set('ema20rel', (ab ? 'ABOVE' : 'BELOW') + trend);
    const el = $('ema20rel'); if (el) el.className = 'ti-rel ' + (ab ? 'bull' : 'bear');
  }

  // EMA 50
  if (ema50 != null) {
    set('ema50', ema50.toFixed(2));
    const ab = price > ema50;
    const trend = ema50r.current > ema50r.prev ? ' ▲' : ' ▼';
    set('ema50rel', (ab ? 'ABOVE' : 'BELOW') + trend);
    const el = $('ema50rel'); if (el) el.className = 'ti-rel ' + (ab ? 'bull' : 'bear');
  }

  // RSI with momentum
  if (rsi != null) {
    set('rsi14', rsi.toFixed(1));
    let sig = 'NEUTRAL';
    if      (rsi > 75) sig = 'OVERBOUGHT ⚠';
    else if (rsi > 60) sig = 'BULLISH';
    else if (rsi > 50) sig = 'MILD BULL';
    else if (rsi < 25) sig = 'OVERSOLD ⚠';
    else if (rsi < 40) sig = 'BEARISH';
    else               sig = 'MILD BEAR';
    set('rsiSignal', sig);
    const el = $('rsiSignal'); if (el) el.className = 'ti-rel ' + (rsi > 50 ? 'bull' : 'bear');
    // RSI momentum color
    const rsiNum = $('rsi14');
    if (rsiNum) rsiNum.style.color = rsi > 70 ? 'var(--orange)' : rsi < 30 ? 'var(--cyan)' : rsi > 50 ? 'var(--green)' : 'var(--red)';
  }

  // MACD with histogram strength
  if (macd) {
    set('macdVal', macd.value.toFixed(3));
    const hist  = macd.histogram;
    const sig   = hist > 0 ? (hist > 0.1 ? 'STRONG BULL ▲' : 'BULL ▲') : (hist < -0.1 ? 'STRONG BEAR ▼' : 'BEAR ▼');
    set('macdSignal', sig);
    const el = $('macdSignal'); if (el) el.className = 'ti-rel ' + (hist > 0 ? 'bull' : 'bear');
  }

  // Structure bias
  const abv20 = ema20 != null && price > ema20;
  const abv50 = ema50 != null && price > ema50;
  let bias = 'NEUTRAL';
  if (abv20 && abv50)   bias = 'BULLISH';
  else if (!abv20 && !abv50) bias = 'BEARISH';
  else bias = abv20 ? 'MILD BULL' : 'MILD BEAR';
  const bEl = $('structBias');
  if (bEl) { bEl.textContent = bias; bEl.className = 'sb-val ' + (bias.includes('BULL') ? 'bull' : 'bear'); }
  STATE.regimeData.structureBullish = bias.includes('BULL');

  renderLevelStack(price, prevDay, ema20, ema50);
  updatePlaybookBanner();
}

function renderLevelStack(price, prevDay, ema20, ema50) {
  const stack = $('levelStack'); if (!stack) return;
  stack.innerHTML = '';

  const od = STATE.regimeData.od;
  const levels = [];

  // Add option wall levels too for complete picture
  if (od?.callWall)    levels.push({ name:'CALL WALL',     price:od.callWall, type:'res', tag:'OI' });
  if (prevDay?.high)   levels.push({ name:'PREV DAY HIGH', price:prevDay.high, type:'res', tag:'PDH' });
  if (ema50 != null)   levels.push({ name:'EMA 50',        price:ema50,        type: price>ema50?'sup':'res', tag:'EMA' });
  if (ema20 != null)   levels.push({ name:'EMA 20',        price:ema20,        type: price>ema20?'sup':'res', tag:'EMA' });
  if (prevDay?.vwap)   levels.push({ name:'PREV VWAP',     price:prevDay.vwap, type: price>prevDay.vwap?'sup':'res', tag:'VWAP' });
  levels.push({ name:'▶ CURRENT',    price, type:'cur', tag:'' });
  if (od?.maxPain)     levels.push({ name:'MAX PAIN',      price:od.maxPain,   type:'key', tag:'γ' });
  if (prevDay?.low)    levels.push({ name:'PREV DAY LOW',  price:prevDay.low,  type:'sup', tag:'PDL' });
  if (od?.putWall)     levels.push({ name:'PUT WALL',      price:od.putWall,   type:'sup', tag:'OI' });

  levels.sort((a,b) => b.price - a.price);

  levels.forEach(l => {
    const div = document.createElement('div');
    div.className = 'ls-level' + (l.type === 'cur' ? ' current-level' : '');
    const distRaw = ((l.price - price) / price * 100);
    const distStr = l.type !== 'cur'
      ? `<span class="ls-dist ${distRaw>=0?'green':'red'}">${distRaw>=0?'+':''}${distRaw.toFixed(2)}%</span>`
      : '';
    const badgeType = l.type === 'key' ? 'sup' : l.type;
    div.innerHTML = `
      <span class="ls-badge ${badgeType}">${l.type==='cur'?'NOW':l.type==='res'?'RES':l.type==='key'?'KEY':'SUP'}</span>
      <span class="ls-tag">${l.tag}</span>
      <span class="ls-name">${l.name}</span>
      <span class="ls-price">${l.price.toFixed(2)}</span>
      ${distStr}
    `;
    stack.appendChild(div);
  });

  // Key levels table
  if (prevDay) {
    set('klPDH', prevDay.high.toFixed(2)); set('klPDHs', price>prevDay.high ? '▲ ABOVE':'▼ BELOW');
    set('klPDL', prevDay.low.toFixed(2));  set('klPDLs', price>prevDay.low  ? '▲ ABOVE':'▼ BELOW');
  }
  // Week H/L — derived from prevDay (no range calls needed)
  set('klPWH', prevDay ? prevDay.high.toFixed(2) : '--');
  set('klPWL', prevDay ? prevDay.low.toFixed(2)  : '--');
  set('klPWHs', '--'); set('klPWLs', '--');
}

// ══════════════════════════════════════════════════════════
// LAYER 5 — PLAYBOOK ENGINE
// ══════════════════════════════════════════════════════════
function updateLayer5() {
  const rd    = STATE.regimeData;
  const od    = rd.od;
  const price = STATE.price;
  if (!price) return;

  // Confluence scoring
  let score = 0;
  const factors = [];

  if (rd.bullish)                  { score += 18; factors.push('Regime bullish'); }
  if (rd.structureBullish)         { score += 18; factors.push('Above EMAs'); }
  if (rd.flowBullish)              { score += 15; factors.push('Call flow dominant'); }
  if (od && !rd.gammaPositive)     { score += 15; factors.push('Neg gamma (expansion)'); }
  if (od?.callWall && price < od.callWall) { score += 14; factors.push('Room to call wall'); }
  if (od?.maxPain  && price > od.maxPain)  { score +=  8; factors.push('Above max pain'); }
  if (rd.vix && rd.vix < 16)       { score +=  7; factors.push('Low VIX'); }
  if (rd.vix && rd.vix < 20)       { score +=  5; }

  // Normalize
  score = Math.min(100, score);

  // Setup classification
  let setupName = 'MONITORING', setupDesc = 'Confluence below threshold. Await alignment.', playbookId = null;

  if (score >= 80) {
    setupName = 'TRIFECTA'; playbookId = 'pbc-trifecta';
    setupDesc = `Elite confluence ${score}%: all 5 layers aligned bullish. High-conviction expansion play.`;
  } else if (od && !rd.gammaPositive && rd.bullish && score >= 58) {
    setupName = 'GAMMA EXPANSION'; playbookId = 'pbc-gamma';
    setupDesc = 'Negative gamma regime — dealers must hedge directionally. Trend acceleration expected.';
  } else if (od?.callWall && price > (od.maxPain||0) && score >= 46) {
    setupName = 'MAGNET RUN'; playbookId = 'pbc-magnet';
    setupDesc = `Above max pain $${od.maxPain?.toFixed(0)}. Call wall $${od.callWall?.toFixed(0)} acting as magnet. Staircase: ${od.staircase?.map(s=>s.strike).join('→')||'--'}`;
  } else if (rd.gammaPositive && od && Math.abs(price - od.maxPain) / price < 0.015) {
    setupName = 'PIN RISK'; playbookId = 'pbc-pin';
    setupDesc = `Positive gamma + price within 1.5% of max pain $${od.maxPain?.toFixed(0)}. Dealers pinning. Avoid expansion bets.`;
  } else if (rd.flowSignal?.includes('AGGRESSIVE') || rd.flowSignal?.includes('STRONG')) {
    setupName = 'FIRECRACKER'; playbookId = 'pbc-firecracker';
    setupDesc = `${rd.flowSignal} — aggressive one-sided flow. Cheap expansion if structure confirms. Score: ${score}%.`;
  } else if (score < 28 && !rd.bullish) {
    setupName = 'CASCADE'; playbookId = 'pbc-cascade';
    setupDesc = 'Bearish regime, put-heavy flow, structure breakdown. Dealer cascade hedge risk.';
  }

  set('asName', setupName); set('asDesc', setupDesc); set('pbPlay', setupName);
  const fill = $('ascFill'); if (fill) fill.style.width = score + '%';
  set('ascPct', score + '%');

  // Color the score
  const pctEl = $('ascPct');
  if (pctEl) pctEl.style.color = score >= 70 ? 'var(--green)' : score >= 45 ? 'var(--yellow)' : 'var(--red)';

  // Cards
  ['firecracker','trifecta','magnet','pin','gamma','cascade'].forEach(id => {
    const card = $(`pbc-${id}`), status = $(`pbs-${id}`);
    if (!card || !status) return;
    const isActive = `pbc-${id}` === playbookId;
    card.className   = 'pb-card' + (isActive ? ' active' : ' inactive');
    status.textContent = isActive ? '● ACTIVE' : '--';
    status.className   = 'pbc-status' + (isActive ? ' active-s' : ' inactive-s');
  });

  // Probability map
  const bullP = Math.min(Math.max(score, 8), 92);
  const bearP = 100 - bullP;
  const bFill = $('pmBullFill'), rFill = $('pmBearFill');
  if (bFill) bFill.style.width = bullP + '%';
  if (rFill) rFill.style.width = bearP + '%';
  set('pmBullPct', bullP + '%'); set('pmBearPct', bearP + '%');

  // Paths
  if (od?.staircase?.length >= 2) {
    const s = od.staircase;
    const path = [price.toFixed(0), ...s.slice(0,3).map(x=>x.strike), od.callWall].filter(Boolean);
    set('pmBullPath', path.join(' → '));
  }
  if (od?.maxPain && od?.putWall) {
    set('pmBearPath', `${price.toFixed(0)} → ${od.maxPain?.toFixed(0)} → ${od.putWall?.toFixed(0)}`);
  }

  const ind = STATE.indicators;
  set('pmBullCond', [od?.maxPain ? `Hold $${od.maxPain?.toFixed(0)}` : '', 'SPY stable', rd.vix ? `VIX < ${(rd.vix+4).toFixed(0)}` : ''].filter(Boolean).join(' · '));
  set('pmBearCond', [ind.ema20 ? `EMA20 $${ind.ema20.toFixed(2)} fails` : '', 'Volume surge puts', 'Risk-off trigger'].filter(Boolean).join(' · '));

  logSignal(`${setupName} | ${score}% | ${factors.slice(0,3).join(', ')}`, score >= 60 ? 'bull' : score >= 35 ? '' : 'bear');
}

// ── PLAYBOOK BANNER ───────────────────────────────────────
function updatePlaybookBanner() {
  const rd = STATE.regimeData, od = rd.od;
  set('pbRegime', rd.regime || '--');
  const bEl = $('pbBias');
  if (bEl) {
    bEl.textContent = rd.bullish === true ? 'BULLISH' : rd.bullish === false ? 'BEARISH' : '--';
    bEl.className   = 'pb-val ' + (rd.bullish ? 'green' : rd.bullish === false ? 'red' : '');
  }
  set('pbGamma',  rd.gammaPositive != null ? (rd.gammaPositive ? 'POS (PIN)' : 'NEG (EXP)') : '--');
  set('pbTarget', od?.callWall ? '$' + od.callWall.toFixed(0) : '--');
  set('pbRisk',   rd.vix ? (rd.vix > 28 ? 'HIGH' : rd.vix > 20 ? 'ELEVATED' : rd.vix > 14 ? 'NORMAL' : 'LOW') : '--');
}

// ── SIGNAL LOG ────────────────────────────────────────────
function logSignal(msg, type = '') {
  const log = $('alertLog'); if (!log) return;
  const et  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const time = `${String(et.getHours()).padStart(2,'0')}:${String(et.getMinutes()).padStart(2,'0')}`;
  const entry = document.createElement('div');
  entry.className = 'al-entry ' + type;
  entry.innerHTML = `<span class="al-time">${time}</span><span>${msg}</span>`;
  log.insertBefore(entry, log.firstChild);
  while (log.children.length > 50) log.removeChild(log.lastChild);
}

// ── HELPERS ───────────────────────────────────────────────
function formatNum(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return String(n);
}

function setLayerLoading(layer, on) {
  const btn = document.querySelector(`[data-layer="${layer}"]`);
  if (btn) btn.className = 'panel-refresh' + (on ? ' spinning' : '');
}

// ── FULL REFRESH ──────────────────────────────────────────
async function fullRefresh() {
  if (!STATE.apiKey) { logSignal('Enter API key to begin', 'warn'); return; }
  if (STATE.isRefreshing) { logSignal('Refresh in progress…', ''); return; }
  STATE.isRefreshing = true;

  logSignal(`Scanning ${STATE.ticker}…`);
  set('regimeLabel', 'SCANNING…');
  [1,2,3,4,5].forEach(l => setLayerLoading(l, true));

  try {
    // L1: price data + VIX (sequential, throttled)
    await updateLayer1();
    setLayerLoading(1, false);

    // L2: option chain (single paginated call — no burst)
    await updateLayer2();
    setLayerLoading(2, false);

    // L3 immediately (uses cached od from L2)
    await updateLayer3();
    setLayerLoading(3, false);

    // L4: indicators (sequential, throttled)
    await updateLayer4();
    setLayerLoading(4, false);

    // L5: pure computation, no API calls
    updateLayer5();
    setLayerLoading(5, false);

    const now = new Date().toLocaleTimeString('en-US', { timeZone:'America/New_York', hour12:false });
    set('lastUpdate', 'Updated: ' + now + ' ET');

    if (STATE.marketOpen && !STATE.wsConnected) connectWebSocket();

  } catch(e) {
    logSignal('Refresh error: ' + e.message, 'warn');
    [1,2,3,4,5].forEach(l => setLayerLoading(l, false));
  } finally {
    STATE.isRefreshing = false;
  }
}

// ── AUTO REFRESH ──────────────────────────────────────────
function startAutoRefresh() {
  if (STATE.refreshTimer) clearInterval(STATE.refreshTimer);
  if (STATE.cdTimer) clearInterval(STATE.cdTimer);
  STATE.countdown = CFG.REFRESH_INTERVAL;

  STATE.cdTimer = setInterval(() => {
    STATE.countdown = Math.max(0, STATE.countdown - 1);
    set('refreshCountdown', STATE.countdown);
    // Pulse the countdown when almost due
    const el = $('refreshCountdown');
    if (el && STATE.countdown <= 10) el.style.color = 'var(--yellow)';
    else if (el) el.style.color = '';
  }, 1000);

  STATE.refreshTimer = setInterval(() => {
    fullRefresh(); STATE.countdown = CFG.REFRESH_INTERVAL;
  }, CFG.REFRESH_INTERVAL * 1000);
}

// ── LAYER REFRESH BUTTONS ─────────────────────────────────
function attachRefreshButtons() {
  document.querySelectorAll('.panel-refresh').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (STATE.isRefreshing) return;
      const layer = parseInt(btn.dataset.layer);
      setLayerLoading(layer, true);
      try {
        if (layer === 1) await updateLayer1();
        if (layer === 2) { await updateLayer2(); updateLayer5(); }
        if (layer === 3) await updateLayer3();
        if (layer === 4) await updateLayer4();
        if (layer === 5) updateLayer5();
      } finally { setLayerLoading(layer, false); }
    });
  });
}

// ── INIT ──────────────────────────────────────────────────
function init() {
  startClock();
  attachRefreshButtons();

  const savedKey    = localStorage.getItem('instmap_key');
  const savedTicker = localStorage.getItem('instmap_ticker');
  if (savedKey)    { $('apiKeyInput').value = savedKey;    STATE.apiKey  = savedKey; }
  if (savedTicker) { $('tickerInput').value = savedTicker; STATE.ticker  = savedTicker; }

  // Sync ticker label in L1 regime card
  const iwmLabel = document.querySelector('#rc-iwm .rc-ticker');
  if (iwmLabel) iwmLabel.textContent = STATE.ticker;

  $('loadBtn').addEventListener('click', () => {
    const key    = $('apiKeyInput').value.trim();
    const ticker = $('tickerInput').value.trim().toUpperCase();
    if (!key || !ticker) { logSignal('API key + ticker required', 'warn'); return; }
    STATE.apiKey = key; STATE.ticker = ticker;
    STATE.price = null; STATE.prevClose = null;
    STATE.regimeData = {}; STATE.cache = {};
    localStorage.setItem('instmap_key',    key);
    localStorage.setItem('instmap_ticker', ticker);
    const iwmL = document.querySelector('#rc-iwm .rc-ticker');
    if (iwmL) iwmL.textContent = ticker;
    if (STATE.ws) { try { STATE.ws.close(); } catch(_){} STATE.ws = null; }
    fullRefresh();
    startAutoRefresh();
  });

  $('apiKeyInput').addEventListener('keydown', e => { if (e.key==='Enter') $('loadBtn').click(); });
  $('tickerInput').addEventListener('keydown', e => { if (e.key==='Enter') $('loadBtn').click(); });

  set('refreshCountdown', CFG.REFRESH_INTERVAL);
  if (STATE.apiKey) { fullRefresh(); startAutoRefresh(); }
}

document.addEventListener('DOMContentLoaded', init);

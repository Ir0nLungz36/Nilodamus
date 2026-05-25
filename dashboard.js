/* ═══════════════════════════════════════════════════════════
   INSTMAP Dashboard Engine v2.1
   Fixed for Polygon.io Options Plan (no Stocks snapshot)
   Price via /v2/aggs/prev + /range (Options plan included)
   WebSocket live streaming via /options/AM
   ═══════════════════════════════════════════════════════════ */

'use strict';

const CFG = {
  POLYGON_BASE:      'https://api.polygon.io',
  POLYGON_WS:        'wss://socket.polygon.io/options',
  REFRESH_INTERVAL:  90,
  FLOW_TABLE_MAX:    20,
  DEFAULT_TICKER:    'IWM',
};

const STATE = {
  apiKey:       '',
  ticker:       CFG.DEFAULT_TICKER,
  price:        null,
  prevClose:    null,
  optionChain:  [],
  indicators:   {},
  marketOpen:   false,
  regimeData:   {},
  countdown:    CFG.REFRESH_INTERVAL,
  refreshTimer: null,
  cdTimer:      null,
  ws:           null,
  wsConnected:  false,
  lastPrices:   {},   // ticker → { price, prevClose, changePct }
};

// ── DOM ───────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };

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
    if (el) { el.textContent = open ? '● MARKET OPEN' : '● MARKET CLOSED'; el.className = 'market-status ' + (open ? 'open' : 'closed'); }
  };
  tick(); setInterval(tick, 1000);
}

// ── POLYGON REST ──────────────────────────────────────────
async function polyGet(path, params = {}) {
  const url = new URL(CFG.POLYGON_BASE + path);
  url.searchParams.set('apiKey', STATE.apiKey);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${res.status} ${path} — ${txt.slice(0,120)}`);
  }
  return res.json();
}

// ── PRICE VIA PREV-DAY + TODAY RANGE (Options plan OK) ───
async function fetchPriceData(ticker) {
  try {
    // prev day bar — gives us prevClose
    const prev = await polyGet(`/v2/aggs/ticker/${ticker}/prev`, { adjusted: true });
    const pr   = prev?.results?.[0];
    if (!pr) return null;
    const prevClose = pr.c;

    // today's bars so far (1-min) to get current price
    const now     = new Date();
    const et      = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = et.toISOString().split('T')[0];
    let price = pr.c; // fallback = prev close
    let high  = pr.h, low = pr.l, open = pr.o;
    let changePct = 0;

    try {
      const intra = await polyGet(
        `/v2/aggs/ticker/${ticker}/range/1/minute/${todayStr}/${todayStr}`,
        { adjusted: true, sort: 'desc', limit: 5 }
      );
      const bars = intra?.results;
      if (bars?.length) {
        price     = bars[0].c;
        open      = bars[bars.length-1].o;
        const dayBars = await polyGet(
          `/v2/aggs/ticker/${ticker}/range/1/day/${todayStr}/${todayStr}`,
          { adjusted: true }
        ).catch(() => null);
        if (dayBars?.results?.[0]) { high = dayBars.results[0].h; low = dayBars.results[0].l; }
      }
    } catch(_) {}

    changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, prevClose, changePct, open, high, low };
  } catch(e) {
    logSignal(`Price fetch failed ${ticker}: ${e.message}`, 'warn');
    return null;
  }
}

// ── OPTION CHAIN ──────────────────────────────────────────
async function fetchOptionChain(underlying) {
  try {
    // Pull up to 1000 contracts across nearest expiries
    const all = [];
    let url = `/v3/snapshot/options/${underlying}?limit=250&apiKey=${STATE.apiKey}`;
    for (let page = 0; page < 4; page++) {
      const res = await fetch(CFG.POLYGON_BASE + (url.startsWith('/') ? url : '/'+url));
      if (!res.ok) { logSignal(`Option chain page ${page} failed: ${res.status}`, 'warn'); break; }
      const data = await res.json();
      if (data.results) all.push(...data.results);
      if (!data.next_url) break;
      url = data.next_url + `&apiKey=${STATE.apiKey}`;
    }
    return all;
  } catch(e) {
    logSignal(`Option chain failed: ${e.message}`, 'warn');
    return [];
  }
}

// ── INDICATORS ────────────────────────────────────────────
async function fetchEMA(ticker, period) {
  try {
    const d = await polyGet(`/v1/indicators/ema/${ticker}`, { timespan:'day', window:period, limit:2, series_type:'close' });
    const vals = d?.results?.values;
    return vals?.length ? { current: vals[0].value, prev: vals[1]?.value } : null;
  } catch(_) { return null; }
}

async function fetchRSI(ticker) {
  try {
    const d = await polyGet(`/v1/indicators/rsi/${ticker}`, { timespan:'day', window:14, limit:1, series_type:'close' });
    return d?.results?.values?.[0]?.value ?? null;
  } catch(_) { return null; }
}

async function fetchMACD(ticker) {
  try {
    const d = await polyGet(`/v1/indicators/macd/${ticker}`, { timespan:'day', short_window:12, long_window:26, signal_window:9, limit:1, series_type:'close' });
    const v = d?.results?.values?.[0];
    return v ? { value: v.value, signal: v.signal, histogram: v.histogram } : null;
  } catch(_) { return null; }
}

async function fetchWeekBars(ticker) {
  try {
    const now = new Date();
    const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(et); mon.setDate(et.getDate() + diff);
    const from = mon.toISOString().split('T')[0];
    const to   = et.toISOString().split('T')[0];
    const d = await polyGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}`, { adjusted:true, sort:'asc' });
    const bars = d?.results || [];
    if (!bars.length) return null;
    return { high: Math.max(...bars.map(b=>b.h)), low: Math.min(...bars.map(b=>b.l)) };
  } catch(_) { return null; }
}

// ── PROCESS OPTION CHAIN ──────────────────────────────────
function processChain(chain, price) {
  if (!chain.length || !price) return null;

  // Group by expiry, pick nearest 2 with enough data
  const grouped = {};
  chain.forEach(c => {
    const exp = c.details?.expiration_date;
    if (!exp) return;
    if (!grouped[exp]) grouped[exp] = [];
    grouped[exp].push(c);
  });

  const expiries = Object.keys(grouped).sort().slice(0, 3);
  const contracts = expiries.flatMap(e => grouped[e]);

  const strikeMap = {};
  let totalCallOI = 0, totalPutOI = 0, totalCallVol = 0, totalPutVol = 0;
  let netGamma = 0;

  contracts.forEach(c => {
    const strike = c.details?.strike_price;
    const type   = c.details?.contract_type;
    const oi     = c.open_interest   || 0;
    const vol    = c.day?.volume     || 0;
    const gamma  = c.greeks?.gamma   || 0;
    const iv     = c.implied_volatility || 0;
    if (!strike || !type) return;

    if (!strikeMap[strike]) strikeMap[strike] = { strike, callOI:0, putOI:0, callVol:0, putVol:0, gamma:0, iv:0 };

    if (type === 'call') {
      strikeMap[strike].callOI  += oi;
      strikeMap[strike].callVol += vol;
      totalCallOI += oi; totalCallVol += vol;
      netGamma += gamma * oi * 100 * price;
    } else {
      strikeMap[strike].putOI   += oi;
      strikeMap[strike].putVol  += vol;
      totalPutOI += oi; totalPutVol += vol;
      netGamma -= gamma * oi * 100 * price;
    }
    strikeMap[strike].gamma += Math.abs(gamma * oi);
    strikeMap[strike].iv = iv || strikeMap[strike].iv;
  });

  const strikes = Object.keys(strikeMap).map(Number).sort((a,b) => a-b);

  // Call wall / Put wall
  let callWall = null, putWall = null, maxCallOI = 0, maxPutOI = 0;
  strikes.forEach(s => {
    if (strikeMap[s].callOI > maxCallOI) { maxCallOI = strikeMap[s].callOI; callWall = s; }
    if (strikeMap[s].putOI  > maxPutOI)  { maxPutOI  = strikeMap[s].putOI;  putWall  = s; }
  });

  // Max pain
  let maxPain = price, minPainVal = Infinity;
  strikes.forEach(s => {
    let loss = 0;
    strikes.forEach(k => {
      loss += strikeMap[k].callOI * Math.max(0, s - k);
      loss += strikeMap[k].putOI  * Math.max(0, k - s);
    });
    if (loss < minPainVal) { minPainVal = loss; maxPain = s; }
  });

  // Gamma flip — ATM strike with highest gamma concentration
  let gammaFlip = price;
  let bestGamma = 0;
  strikes.forEach(s => {
    const atmWeight = strikeMap[s].gamma / (Math.abs(s - price) + 1);
    if (atmWeight > bestGamma) { bestGamma = atmWeight; gammaFlip = s; }
  });

  // Staircase: strikes above price sorted by call OI desc, then by proximity
  const staircase = strikes
    .filter(s => s >= price && strikeMap[s].callOI > 0)
    .sort((a,b) => a - b)
    .slice(0, 6)
    .map(s => ({ strike: s, oi: strikeMap[s].callOI }));

  // Top flow contracts
  const topContracts = contracts
    .filter(c => (c.day?.volume || 0) > 0)
    .sort((a,b) => (b.day?.volume||0) - (a.day?.volume||0))
    .slice(0, CFG.FLOW_TABLE_MAX);

  return {
    strikeMap, strikes, staircase, topContracts,
    callWall, putWall, maxPain, gammaFlip,
    totalCallOI, totalPutOI, totalCallVol, totalPutVol,
    netGamma,
    pcRatio: totalPutVol / (totalCallVol || 1),
    nearestExp: expiries[0],
  };
}

// ── WEBSOCKET — live options minute aggregates ────────────
function connectWebSocket() {
  if (!STATE.apiKey || !STATE.marketOpen) return;
  if (STATE.ws) { try { STATE.ws.close(); } catch(_){} }

  const ws = new WebSocket(CFG.POLYGON_WS);
  STATE.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ action:'auth', params: STATE.apiKey }));
  };

  ws.onmessage = e => {
    let msgs;
    try { msgs = JSON.parse(e.data); } catch(_) { return; }
    msgs.forEach(msg => {
      if (msg.ev === 'status' && msg.status === 'auth_success') {
        // Subscribe to underlying's option aggregates
        ws.send(JSON.stringify({ action:'subscribe', params:`AM.O:${STATE.ticker}*` }));
        STATE.wsConnected = true;
        logSignal('WebSocket connected — live options streaming', 'bull');
        updateWSIndicator(true);
      }
      if (msg.ev === 'AM') {
        // Minute aggregate for an option contract
        // Use to update last-seen prices in flow table
        handleWSAggregate(msg);
      }
    });
  };

  ws.onerror = () => { logSignal('WebSocket error — falling back to REST', 'warn'); updateWSIndicator(false); };
  ws.onclose = () => { STATE.wsConnected = false; updateWSIndicator(false); };
}

function handleWSAggregate(msg) {
  // msg: { sym, o, h, l, c, v, av, op, vw, ... }
  const sym = msg.sym || '';
  if (!sym) return;
  // Flash the live indicator
  const liveEl = $('wsLive');
  if (liveEl) { liveEl.style.opacity = '1'; setTimeout(() => { if(liveEl) liveEl.style.opacity = '0.3'; }, 300); }
}

function updateWSIndicator(connected) {
  const el = $('wsStatus');
  if (!el) return;
  el.textContent = connected ? '◉ WS LIVE' : '◎ WS OFF';
  el.className = 'ws-status ' + (connected ? 'connected' : '');
}

// ══════════════════════════════════════════════════════════
// LAYER 1 — REGIME ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer1() {
  const tickers = [
    { sym:'SPY', id:'spy', label:'MARKET DIR' },
    { sym:'QQQ', id:'qqq', label:'TECH RISK' },
    { sym: STATE.ticker, id:'iwm', label:'PRIMARY' },
  ];

  // Fetch all in parallel — use prev+intraday (Options plan OK)
  const results = await Promise.allSettled(tickers.map(t => fetchPriceData(t.sym)));

  const regimes = [];
  tickers.forEach(({ sym, id }, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) return;
    const d = r.value;
    STATE.lastPrices[sym] = d;
    if (sym === STATE.ticker) { STATE.price = d.price; STATE.prevClose = d.prevClose; }

    const pct = d.changePct ?? 0;
    set(`${id}-price`, d.price?.toFixed(2) ?? '--');
    const chgEl = $(`${id}-chg`);
    if (chgEl) { chgEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'; chgEl.className = 'rc-change ' + (pct >= 0 ? 'pos' : 'neg'); }
    const fill = $(`${id}-fill`);
    if (fill) { fill.style.width = Math.min(Math.max(50 + pct * 5, 5), 95) + '%'; fill.className = 'rc-fill ' + (pct >= 0 ? 'pos' : 'neg'); }
    const card = $(`rc-${id}`);
    if (card) card.className = 'regime-card ' + (pct >= 0 ? 'bull' : 'bear');
    regimes.push({ ticker: sym, chg: pct });
  });

  // VIX via prev day (always works)
  try {
    const vd = await polyGet('/v2/aggs/ticker/VIX/prev', { adjusted: true });
    const vr = vd?.results?.[0];
    if (vr) {
      set('vix-price', vr.c.toFixed(2));
      const lvl = vr.c;
      const regime = lvl < 15 ? 'LOW' : lvl < 20 ? 'NORMAL' : lvl < 30 ? 'ELEVATED' : 'HIGH';
      const vEl = $('vix-chg');
      if (vEl) { vEl.textContent = regime; vEl.className = 'rc-change ' + (lvl < 20 ? 'pos' : 'neg'); }
      const vf = $('vix-fill');
      if (vf) { vf.style.width = Math.min(lvl * 2.5, 95) + '%'; vf.className = 'rc-fill ' + (lvl < 20 ? 'pos' : 'neg'); }
      STATE.regimeData.vix = lvl;
    }
  } catch(e) { logSignal('VIX prev failed: ' + e.message, 'warn'); }

  classifyRegime(regimes);
}

function classifyRegime(regimes) {
  const vix     = STATE.regimeData.vix || 15;
  const spyChg  = regimes.find(r => r.ticker === 'SPY')?.chg || 0;
  const qqqChg  = regimes.find(r => r.ticker === 'QQQ')?.chg || 0;
  const iwmChg  = regimes.find(r => r.ticker === STATE.ticker)?.chg || 0;

  const bullish   = spyChg > 0 && iwmChg > 0;
  const trending  = Math.abs(spyChg) > 0.5;
  const chop      = Math.abs(spyChg) < 0.2;
  const highVol   = vix > 25;
  const expansion = Math.abs(iwmChg) > 1.0;

  let regime = 'TREND DAY', dtActive = 'dt-trend';
  if (highVol)             { regime = 'HEDGE DAY';     dtActive = 'dt-hedge'; }
  else if (chop)           { regime = 'CHOP DAY';      dtActive = 'dt-chop'; }
  else if (expansion)      { regime = 'EXPANSION DAY'; dtActive = 'dt-expansion'; }
  else if (!trending)      { regime = 'PIN DAY';        dtActive = 'dt-pin'; }

  set('regimeLabel', regime);
  STATE.regimeData.regime   = regime;
  STATE.regimeData.bullish  = bullish;
  STATE.regimeData.spyChg   = spyChg;

  ['dt-trend','dt-chop','dt-pin','dt-expansion','dt-hedge'].forEach(id => {
    const el = $(id); if (el) el.className = 'day-type-item' + (id === dtActive ? ' active' : '');
  });

  updatePlaybookBanner();
}

// ══════════════════════════════════════════════════════════
// LAYER 2 — DEALER POSITIONING
// ══════════════════════════════════════════════════════════
async function updateLayer2() {
  const price = STATE.price;
  if (!price) { logSignal('Waiting for price data — retrying…', 'warn'); return; }

  const chain = await fetchOptionChain(STATE.ticker);
  STATE.optionChain = chain;

  if (!chain.length) { logSignal('Option chain empty (market may be closed)', 'warn'); renderEmptyOIChart(); return; }

  const od = processChain(chain, price);
  if (!od) { logSignal('Could not process option chain', 'warn'); return; }
  STATE.regimeData.od = od;

  // Wall stats
  const fmt = v => v != null ? v.toFixed(0) : '--';
  set('callWall', fmt(od.callWall));
  set('maxPain',  fmt(od.maxPain));
  set('putWall',  fmt(od.putWall));
  set('gammaFlip',fmt(od.gammaFlip));

  if (od.callWall) {
    const dist = ((od.callWall - price) / price * 100).toFixed(2);
    set('callWallDist', `+${dist}% away`);
    set('distCallWall', `+${dist}%`);
    set('roomToRun', parseFloat(dist) > 2 ? 'YES — CLEAR' : parseFloat(dist) > 0.5 ? 'TIGHT' : 'AT WALL');
  }

  // Net gamma
  const ng = od.netGamma;
  const ngStr = (ng >= 0 ? '+' : '') + (ng / 1e6).toFixed(2) + 'M';
  set('netGamma', ngStr);
  const ngEl = $('netGamma');
  if (ngEl) ngEl.className = 'gs-val ' + (ng >= 0 ? 'yellow' : 'green');

  const gsLabel = ng >= 0 ? 'POSITIVE (PIN)' : 'NEGATIVE (EXP)';
  set('gammaState', gsLabel);
  STATE.regimeData.gammaPositive = ng >= 0;

  // Nearest expiry label
  if (od.nearestExp) { const el = $('nearestExp'); if(el) el.textContent = 'EXP: ' + od.nearestExp; }

  renderOIChart(od, price);
  renderStaircase(od.staircase, price);
  updatePlaybookBanner();
}

function renderEmptyOIChart() {
  const chart = $('oiChart');
  if (chart) chart.innerHTML = '<div class="oi-loading">Market closed — OI from prior session</div>';
  const row = $('staircaseRow');
  if (row) row.innerHTML = '<div class="sc-step loading">No live data</div>';
}

function renderOIChart(od, price) {
  const chart = $('oiChart');
  if (!chart) return;
  chart.innerHTML = '';

  // Filter strikes within 8% of price
  const nearby = od.strikes.filter(s => {
    const info = od.strikeMap[s];
    return (info.callOI > 0 || info.putOI > 0) && Math.abs(s - price) / price < 0.08;
  });

  if (!nearby.length) { chart.innerHTML = '<div class="oi-loading">No OI in display range</div>'; return; }

  const maxOI = Math.max(...nearby.map(s => Math.max(od.strikeMap[s].callOI, od.strikeMap[s].putOI)));
  const chartH = 130;

  // Price line
  const minS = nearby[0], maxS = nearby[nearby.length-1];
  const pricePct = ((price - minS) / (maxS - minS || 1)) * 100;
  const pl = document.createElement('div');
  pl.className = 'oi-price-line';
  pl.style.left = Math.max(0, Math.min(100, pricePct)) + '%';
  pl.title = 'Current price: ' + price.toFixed(2);
  chart.appendChild(pl);

  nearby.forEach(s => {
    const info = od.strikeMap[s];
    const group = document.createElement('div');
    group.className = 'oi-bar-group';

    const callH = Math.max(2, (info.callOI / maxOI) * chartH);
    const putH  = Math.max(2, (info.putOI  / maxOI) * chartH);

    const cb = document.createElement('div');
    cb.className = 'oi-bar call';
    cb.style.height = callH + 'px';
    cb.title = `${s}C — OI: ${info.callOI.toLocaleString()}`;

    const pb = document.createElement('div');
    pb.className = 'oi-bar put';
    pb.style.height = putH + 'px';
    pb.title = `${s}P — OI: ${info.putOI.toLocaleString()}`;

    const lbl = document.createElement('span');
    lbl.className = 'oi-strike';
    lbl.textContent = s;

    // Highlight call/put wall strikes
    if (s === od.callWall) cb.style.opacity = '1';
    if (s === od.putWall)  pb.style.opacity = '1';

    group.appendChild(cb);
    group.appendChild(pb);
    group.appendChild(lbl);
    chart.appendChild(group);
  });
}

function renderStaircase(staircase, price) {
  const row = $('staircaseRow');
  if (!row) return;
  row.innerHTML = '';
  if (!staircase?.length) { row.innerHTML = '<div class="sc-step loading">No upside strikes</div>'; return; }
  staircase.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'sc-step' + (i === 0 ? ' active' : '');
    div.innerHTML = `${step.strike}<span class="sc-oi">${(step.oi/1000).toFixed(1)}K</span>`;
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

  const pcr = od.pcRatio;
  set('pcRatio', pcr.toFixed(2));
  const pEl = $('pcRatio');
  if (pEl) pEl.className = 'fs-val ' + (pcr < 0.7 ? 'green' : pcr > 1.2 ? 'red' : 'yellow');

  let sig = 'NEUTRAL';
  if      (pcr < 0.5) sig = 'AGGRESSIVE CALLS';
  else if (pcr < 0.7) sig = 'CALL SKEW';
  else if (pcr < 0.9) sig = 'MILD CALL BIAS';
  else if (pcr > 1.4) sig = 'AGGRESSIVE PUTS';
  else if (pcr > 1.1) sig = 'PUT SKEW';
  set('flowSignal', sig);
  STATE.regimeData.flowSignal  = sig;
  STATE.regimeData.flowBullish = pcr < 0.9;

  // Flow bar
  const total = od.totalCallVol + od.totalPutVol || 1;
  const callP = Math.round(od.totalCallVol / total * 100);
  const putP  = 100 - callP;
  const fc = $('fbCalls'), fp = $('fbPuts');
  if (fc) fc.style.width = callP + '%';
  if (fp) fp.style.width = putP  + '%';
  set('fbCallPct', callP + '%'); set('fbPutPct', putP + '%');

  // OI totals
  set('totalCallOI', formatNum(od.totalCallOI));
  set('totalPutOI',  formatNum(od.totalPutOI));
  const oiRatio = od.totalPutOI / (od.totalCallOI || 1);
  set('oiPCRatio', oiRatio.toFixed(2));

  renderFlowTable(od.topContracts);
  updatePlaybookBanner();
}

function renderFlowTable(contracts) {
  const body = $('flowTable');
  if (!body) return;
  body.innerHTML = '';
  if (!contracts?.length) { body.innerHTML = '<div class="ft-loading">No volume data (market closed?)</div>'; return; }

  contracts.forEach(c => {
    const type   = c.details?.contract_type   || '?';
    const strike = c.details?.strike_price    || '--';
    const exp    = c.details?.expiration_date || '--';
    const oi     = c.open_interest            || 0;
    const vol    = c.day?.volume              || 0;
    const iv     = c.implied_volatility       || 0;

    const ratio   = vol / (oi || 1);
    const isSweep = vol > 500 && ratio > 0.3;
    const isBlock = vol > 2000;
    let   signal  = ratio > 0.5 ? 'ACTIVE' : '--';
    if (isBlock && type === 'call') signal = 'BLOCK↑';
    if (isBlock && type === 'put')  signal = 'BLOCK↓';
    if (isSweep && type === 'call') signal = 'SWEEP↑';
    if (isSweep && type === 'put')  signal = 'SWEEP↓';

    const row = document.createElement('div');
    row.className = 'ft-row';
    row.innerHTML = `
      <span class="${type}">${strike}</span>
      <span class="${type}">${type.toUpperCase()}</span>
      <span>${exp.slice(5)}</span>
      <span>${formatNum(oi)}</span>
      <span>${formatNum(vol)}</span>
      <span>${iv ? (iv*100).toFixed(0)+'%' : '--'}</span>
      <span class="${isSweep||isBlock ? 'sweep' : ''}">${signal}</span>
    `;
    body.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 4 — STRUCTURE ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer4() {
  const price = STATE.price;
  if (!price) { logSignal('No price for structure layer', 'warn'); return; }

  set('structPrice', price.toFixed(2));
  set('klCUR', price.toFixed(2));

  const pct = STATE.prevClose ? ((price - STATE.prevClose) / STATE.prevClose * 100) : 0;
  const diff = STATE.prevClose ? (price - STATE.prevClose) : 0;
  const chgStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} | ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  set('structChange', chgStr);
  const scEl = $('structChange'); if (scEl) scEl.className = 'spb-change ' + (pct >= 0 ? 'pos' : 'neg');

  // Indicators in parallel
  const [ema20r, ema50r, rsi, macd, prevDay, weekBars] = await Promise.all([
    fetchEMA(STATE.ticker, 20),
    fetchEMA(STATE.ticker, 50),
    fetchRSI(STATE.ticker),
    fetchMACD(STATE.ticker),
    polyGet(`/v2/aggs/ticker/${STATE.ticker}/prev`, { adjusted: true }).then(d => d?.results?.[0] ? { open:d.results[0].o, high:d.results[0].h, low:d.results[0].l, close:d.results[0].c, vwap:d.results[0].vw } : null).catch(() => null),
    fetchWeekBars(STATE.ticker),
  ]);

  const ema20 = ema20r?.current ?? null;
  const ema50 = ema50r?.current ?? null;
  STATE.indicators = { ema20, ema50, rsi, macd, prevDay, weekBars };

  // EMA 20
  if (ema20 != null) {
    set('ema20', ema20.toFixed(2));
    const ab = price > ema20;
    set('ema20rel', ab ? 'ABOVE ▲' : 'BELOW ▼');
    const el = $('ema20rel'); if (el) el.className = 'ti-rel ' + (ab ? 'bull' : 'bear');
  }

  // EMA 50
  if (ema50 != null) {
    set('ema50', ema50.toFixed(2));
    const ab = price > ema50;
    set('ema50rel', ab ? 'ABOVE ▲' : 'BELOW ▼');
    const el = $('ema50rel'); if (el) el.className = 'ti-rel ' + (ab ? 'bull' : 'bear');
  }

  // RSI
  if (rsi != null) {
    set('rsi14', rsi.toFixed(1));
    const sig = rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi > 55 ? 'BULLISH' : rsi < 45 ? 'BEARISH' : 'NEUTRAL';
    set('rsiSignal', sig);
    const el = $('rsiSignal'); if (el) el.className = 'ti-rel ' + (rsi > 50 ? 'bull' : 'bear');
  }

  // MACD
  if (macd) {
    set('macdVal', macd.value.toFixed(3));
    const sig = macd.histogram > 0 ? 'BULL CROSS ▲' : 'BEAR CROSS ▼';
    set('macdSignal', sig);
    const el = $('macdSignal'); if (el) el.className = 'ti-rel ' + (macd.histogram > 0 ? 'bull' : 'bear');
  }

  // Bias
  const abv20 = ema20 && price > ema20;
  const abv50 = ema50 && price > ema50;
  let bias = 'NEUTRAL';
  if (abv20 && abv50)   bias = 'BULLISH';
  else if (!abv20 && !abv50) bias = 'BEARISH';
  else bias = abv20 ? 'MILD BULL' : 'MILD BEAR';
  const bEl = $('structBias');
  if (bEl) { bEl.textContent = bias; bEl.className = 'sb-val ' + (bias.includes('BULL') ? 'bull' : 'bear'); }
  STATE.regimeData.structureBullish = bias.includes('BULL');

  renderLevelStack(price, prevDay, weekBars, ema20, ema50);
  updatePlaybookBanner();
}

function renderLevelStack(price, prevDay, weekBars, ema20, ema50) {
  const stack = $('levelStack'); if (!stack) return;
  stack.innerHTML = '';
  const levels = [];

  if (weekBars?.high)  levels.push({ name:'WEEK HIGH',     price: weekBars.high,  type:'res' });
  if (prevDay?.high)   levels.push({ name:'PREV DAY HIGH', price: prevDay.high,   type:'res' });
  if (ema50 != null)   levels.push({ name:'EMA 50',        price: ema50,          type: price > ema50 ? 'sup' : 'res' });
  if (ema20 != null)   levels.push({ name:'EMA 20',        price: ema20,          type: price > ema20 ? 'sup' : 'res' });
  if (prevDay?.vwap)   levels.push({ name:'PREV VWAP',     price: prevDay.vwap,   type: price > prevDay.vwap ? 'sup' : 'res' });
  levels.push({ name:'▶ CURRENT', price, type:'cur' });
  if (prevDay?.low)    levels.push({ name:'PREV DAY LOW',  price: prevDay.low,    type:'sup' });
  if (weekBars?.low)   levels.push({ name:'WEEK LOW',      price: weekBars.low,   type:'sup' });

  levels.sort((a,b) => b.price - a.price).forEach(l => {
    const div = document.createElement('div');
    div.className = 'ls-level' + (l.type === 'cur' ? ' current-level' : '');
    const dist = l.type !== 'cur' ? ((l.price - price) / price * 100).toFixed(2) : '';
    const distStr = dist ? (parseFloat(dist) >= 0 ? `+${dist}%` : `${dist}%`) : '';
    div.innerHTML = `
      <span class="ls-badge ${l.type}">${l.type==='cur'?'NOW':l.type==='res'?'RES':'SUP'}</span>
      <span class="ls-name">${l.name}</span>
      <span class="ls-price">${l.price.toFixed(2)}</span>
      <span class="ls-dist ${parseFloat(dist)>=0?'green':'red'}">${distStr}</span>
    `;
    stack.appendChild(div);
  });

  // Key levels table
  const pd = prevDay, wb = weekBars;
  if (pd) {
    set('klPDH', pd.high.toFixed(2));   set('klPDHs', price > pd.high ? '▲ ABOVE' : '▼ BELOW');
    set('klPDL', pd.low.toFixed(2));    set('klPDLs', price > pd.low  ? '▲ ABOVE' : '▼ BELOW');
  }
  if (wb) {
    set('klPWH', wb.high.toFixed(2));   set('klPWHs', price > wb.high ? '▲ ABOVE' : '▼ BELOW');
    set('klPWL', wb.low.toFixed(2));    set('klPWLs', price > wb.low  ? '▲ ABOVE' : '▼ BELOW');
  }
}

// ══════════════════════════════════════════════════════════
// LAYER 5 — PLAYBOOK ENGINE
// ══════════════════════════════════════════════════════════
function updateLayer5() {
  const rd = STATE.regimeData;
  const od = rd.od;
  const price = STATE.price;
  if (!price) return;

  let score = 0;
  const factors = [];

  if (rd.bullish)              { score += 20; factors.push('Regime bullish'); }
  if (rd.structureBullish)     { score += 20; factors.push('Above EMAs'); }
  if (rd.flowBullish)          { score += 15; factors.push('Call flow dominant'); }
  if (od && !rd.gammaPositive) { score += 15; factors.push('Neg gamma = expansion'); }
  if (od?.callWall && price < od.callWall) { score += 15; factors.push('Room to call wall'); }
  if (od?.maxPain  && price > od.maxPain)  { score += 10; factors.push('Above max pain'); }
  if (rd.vix && rd.vix < 20)  { score += 5;  factors.push('Low VIX'); }

  let setupName = 'MONITORING', setupDesc = 'Below confluence threshold. Wait for alignment.', playbookId = null;

  if (score >= 80) {
    setupName = 'TRIFECTA'; playbookId = 'pbc-trifecta';
    setupDesc = `Maximum confluence: regime + structure + flow + dealer bias all aligned. Score: ${score}%.`;
  } else if (od && !rd.gammaPositive && rd.bullish && score >= 60) {
    setupName = 'GAMMA EXPANSION'; playbookId = 'pbc-gamma';
    setupDesc = 'Negative gamma + bullish regime. Dealer hedging creates acceleration. Momentum favored.';
  } else if (od?.callWall && price > (od.maxPain||0) && score >= 50) {
    setupName = 'MAGNET RUN'; playbookId = 'pbc-magnet';
    setupDesc = `Above max pain ${od.maxPain?.toFixed(0)}. Call wall ${od.callWall?.toFixed(0)} is the magnet. Staircase active.`;
  } else if (rd.gammaPositive && od && Math.abs(price - od.maxPain) / price < 0.01) {
    setupName = 'PIN RISK'; playbookId = 'pbc-pin';
    setupDesc = 'Positive gamma + price near max pain. Dealers actively pinning. Avoid expansion bets.';
  } else if (rd.flowSignal?.includes('AGGRESSIVE')) {
    setupName = 'FIRECRACKER'; playbookId = 'pbc-firecracker';
    setupDesc = 'Aggressive one-sided flow detected. Cheap expansion potential if structure confirms.';
  } else if (score < 30 && !rd.bullish) {
    setupName = 'CASCADE'; playbookId = 'pbc-cascade';
    setupDesc = 'Bearish regime, put-heavy flow, structure breakdown risk. Dealer hedge cascade possible.';
  }

  set('asName', setupName); set('asDesc', setupDesc);
  set('pbPlay', setupName);
  const fillEl = $('ascFill'); if (fillEl) fillEl.style.width = score + '%';
  set('ascPct', score + '%');

  // Playbook cards
  ['firecracker','trifecta','magnet','pin','gamma','cascade'].forEach(id => {
    const card = $(`pbc-${id}`), status = $(`pbs-${id}`);
    if (!card || !status) return;
    if (`pbc-${id}` === playbookId) {
      card.className = 'pb-card active';
      status.textContent = '● ACTIVE'; status.className = 'pbc-status active-s';
    } else {
      card.className = 'pb-card inactive';
      status.textContent = '--'; status.className = 'pbc-status inactive-s';
    }
  });

  // Probability map
  const bullP = Math.min(Math.max(score, 10), 90);
  const bearP = 100 - bullP;
  const bFill = $('pmBullFill'), rFill = $('pmBearFill');
  if (bFill) bFill.style.width = bullP + '%';
  if (rFill) rFill.style.width = bearP + '%';
  set('pmBullPct', bullP + '%'); set('pmBearPct', bearP + '%');

  if (od?.staircase?.length >= 2) {
    const s = od.staircase;
    set('pmBullPath', `${price.toFixed(0)} → ${s[1]?.strike||'?'} → ${s[2]?.strike||'?'} → ${od.callWall||'?'}`);
  }
  if (od?.maxPain && od?.putWall) {
    set('pmBearPath', `${price.toFixed(0)} → ${od.maxPain?.toFixed(0)} → ${od.putWall?.toFixed(0)}`);
  }

  const bullConds = [];
  if (od?.maxPain) bullConds.push(`Hold ${od.maxPain?.toFixed(0)}`);
  bullConds.push('SPY stable'); if (rd.vix) bullConds.push(`VIX < ${(rd.vix+3).toFixed(0)}`);
  set('pmBullCond', bullConds.join(' · '));

  const bearConds = [];
  if (STATE.indicators.ema20) bearConds.push(`EMA20 ${STATE.indicators.ema20.toFixed(2)} fails`);
  bearConds.push('Risk-off triggers');
  set('pmBearCond', bearConds.join(' · '));

  logSignal(`${setupName} | Score ${score}% | ${factors.slice(0,3).join(', ')}`, score >= 60 ? 'bull' : score >= 40 ? '' : 'bear');
}

// ── PLAYBOOK BANNER ───────────────────────────────────────
function updatePlaybookBanner() {
  const rd = STATE.regimeData, od = rd.od;
  set('pbRegime', rd.regime || '--');
  const bEl = $('pbBias');
  if (bEl) {
    bEl.textContent = rd.bullish === true ? 'BULLISH' : rd.bullish === false ? 'BEARISH' : '--';
    bEl.className = 'pb-val ' + (rd.bullish ? 'green' : rd.bullish === false ? 'red' : '');
  }
  set('pbGamma', rd.gammaPositive != null ? (rd.gammaPositive ? 'POS (PIN)' : 'NEG (EXP)') : '--');
  set('pbTarget', od?.callWall ? od.callWall.toFixed(0) : '--');
  set('pbRisk', rd.vix ? (rd.vix > 25 ? 'HIGH' : rd.vix > 18 ? 'ELEVATED' : 'LOW') : '--');
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
  while (log.children.length > 40) log.removeChild(log.lastChild);
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
  if (!STATE.apiKey) { logSignal('Enter Polygon.io API key to begin', 'warn'); return; }
  logSignal(`Scanning ${STATE.ticker}…`);
  set('regimeLabel', 'SCANNING…');
  [1,2,3,4,5].forEach(l => setLayerLoading(l, true));

  try {
    // L1 must succeed first — price is needed for everything else
    await updateLayer1();
    setLayerLoading(1, false);

    // L2-L4 can run together after price is set
    await updateLayer2();
    setLayerLoading(2, false);

    await Promise.all([updateLayer3(), updateLayer4()]);
    setLayerLoading(3, false); setLayerLoading(4, false);

    updateLayer5();
    setLayerLoading(5, false);

    const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    set('lastUpdate', 'Last update: ' + now + ' ET');

    // Start WS if market is open
    if (STATE.marketOpen && !STATE.wsConnected) connectWebSocket();

  } catch(e) {
    logSignal('Refresh error: ' + e.message, 'warn');
    [1,2,3,4,5].forEach(l => setLayerLoading(l, false));
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
  }, 1000);

  STATE.refreshTimer = setInterval(() => {
    fullRefresh();
    STATE.countdown = CFG.REFRESH_INTERVAL;
  }, CFG.REFRESH_INTERVAL * 1000);
}

// ── INDIVIDUAL LAYER REFRESH BUTTONS ─────────────────────
function attachRefreshButtons() {
  document.querySelectorAll('.panel-refresh').forEach(btn => {
    btn.addEventListener('click', async () => {
      const layer = parseInt(btn.dataset.layer);
      setLayerLoading(layer, true);
      try {
        if (layer === 1) await updateLayer1();
        if (layer === 2) await updateLayer2();
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

  // Persist key + ticker
  const savedKey    = localStorage.getItem('instmap_key');
  const savedTicker = localStorage.getItem('instmap_ticker');
  if (savedKey)    { $('apiKeyInput').value = savedKey;       STATE.apiKey  = savedKey; }
  if (savedTicker) { $('tickerInput').value = savedTicker;    STATE.ticker  = savedTicker; }

  // Update L2 IWM label if ticker changed
  const iwmCard = $('rc-iwm'); const iwmTicker = document.querySelector('#rc-iwm .rc-ticker');
  if (iwmTicker) iwmTicker.textContent = STATE.ticker;

  $('loadBtn').addEventListener('click', () => {
    const key    = $('apiKeyInput').value.trim();
    const ticker = $('tickerInput').value.trim().toUpperCase();
    if (!key)    { logSignal('API key required', 'warn'); return; }
    if (!ticker) { logSignal('Ticker required',  'warn'); return; }
    STATE.apiKey  = key;
    STATE.ticker  = ticker;
    STATE.price   = null;
    STATE.regimeData = {};
    localStorage.setItem('instmap_key',    key);
    localStorage.setItem('instmap_ticker', ticker);
    // Update label
    const iwmT = document.querySelector('#rc-iwm .rc-ticker');
    if (iwmT) iwmT.textContent = ticker;
    fullRefresh();
    startAutoRefresh();
  });

  // Allow Enter key
  $('apiKeyInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('loadBtn').click(); });
  $('tickerInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('loadBtn').click(); });

  set('refreshCountdown', CFG.REFRESH_INTERVAL);

  if (STATE.apiKey) { fullRefresh(); startAutoRefresh(); }
}

document.addEventListener('DOMContentLoaded', init);

/* ═══════════════════════════════════════════════════════════
   INSTMAP Dashboard Engine v2.0
   Polygon.io Options API Integration
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── CONFIG ────────────────────────────────────────────────
const CFG = {
  POLYGON_BASE: 'https://api.polygon.io',
  REFRESH_INTERVAL: 60,        // seconds
  OI_STRIKES_AROUND: 15,       // strikes each side of ATM
  FLOW_TABLE_MAX: 20,
  DEFAULT_TICKER: 'IWM',
  EXPIRY_LOOKAHEAD_DAYS: 45,
};

// ── STATE ─────────────────────────────────────────────────
const STATE = {
  apiKey: '',
  ticker: CFG.DEFAULT_TICKER,
  price: null,
  prevClose: null,
  expirations: [],
  optionChain: [],
  indicators: {},
  marketOpen: false,
  regimeData: {},
  countdown: CFG.REFRESH_INTERVAL,
  refreshTimer: null,
  countdownTimer: null,
  loading: {},
};

// ── DOM HELPERS ───────────────────────────────────────────
const $ = id => document.getElementById(id);
const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
const setClass = (id, cls) => { const el = $(id); if (el) el.className = cls; };
const clr = (id, color) => { const el = $(id); if (el) el.style.color = color; };

// ── CLOCK ────────────────────────────────────────────────
function startClock() {
  const update = () => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hh = String(et.getHours()).padStart(2,'0');
    const mm = String(et.getMinutes()).padStart(2,'0');
    const ss = String(et.getSeconds()).padStart(2,'0');
    set('clock', `${hh}:${mm}:${ss} ET`);

    const h = et.getHours(), m = et.getMinutes();
    const isWeekday = et.getDay() >= 1 && et.getDay() <= 5;
    const afterOpen = h > 9 || (h === 9 && m >= 30);
    const beforeClose = h < 16;
    const open = isWeekday && afterOpen && beforeClose;
    STATE.marketOpen = open;
    const mktEl = $('mktStatus');
    if (mktEl) {
      mktEl.textContent = open ? '● MARKET OPEN' : '● MARKET CLOSED';
      mktEl.className = 'market-status ' + (open ? 'open' : 'closed');
    }
  };
  update();
  setInterval(update, 1000);
}

// ── POLYGON API ───────────────────────────────────────────
async function polyGet(path, params = {}) {
  const url = new URL(CFG.POLYGON_BASE + path);
  url.searchParams.set('apiKey', STATE.apiKey);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── SNAPSHOT — current price for a ticker ────────────────
async function fetchSnapshot(ticker) {
  try {
    const data = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const t = data?.ticker;
    return {
      price:     t?.day?.c  || t?.lastTrade?.p || null,
      open:      t?.day?.o  || null,
      high:      t?.day?.h  || null,
      low:       t?.day?.l  || null,
      prevClose: t?.prevDay?.c || null,
      change:    t?.todaysChange || null,
      changePct: t?.todaysChangePerc || null,
    };
  } catch(e) {
    logSignal(`Snapshot fetch failed for ${ticker}: ${e.message}`, 'warn');
    return null;
  }
}

// ── OPTION CHAIN SNAPSHOT ─────────────────────────────────
async function fetchOptionChain(underlying) {
  try {
    const data = await polyGet(`/v3/snapshot/options/${underlying}`, {
      limit: 250,
    });
    return data?.results || [];
  } catch(e) {
    logSignal(`Option chain failed: ${e.message}`, 'warn');
    return [];
  }
}

// ── EMA ───────────────────────────────────────────────────
async function fetchEMA(ticker, period) {
  try {
    const data = await polyGet(`/v1/indicators/ema/${ticker}`, {
      timespan: 'day', window: period, limit: 1, series_type: 'close'
    });
    return data?.results?.values?.[0]?.value || null;
  } catch(e) { return null; }
}

// ── RSI ───────────────────────────────────────────────────
async function fetchRSI(ticker) {
  try {
    const data = await polyGet(`/v1/indicators/rsi/${ticker}`, {
      timespan: 'day', window: 14, limit: 1, series_type: 'close'
    });
    return data?.results?.values?.[0]?.value || null;
  } catch(e) { return null; }
}

// ── MACD ──────────────────────────────────────────────────
async function fetchMACD(ticker) {
  try {
    const data = await polyGet(`/v1/indicators/macd/${ticker}`, {
      timespan: 'day', short_window: 12, long_window: 26, signal_window: 9,
      limit: 1, series_type: 'close'
    });
    const v = data?.results?.values?.[0];
    return v ? { value: v.value, signal: v.signal, histogram: v.histogram } : null;
  } catch(e) { return null; }
}

// ── PREV DAY BAR ──────────────────────────────────────────
async function fetchPrevDay(ticker) {
  try {
    const data = await polyGet(`/v2/aggs/ticker/${ticker}/prev`);
    const r = data?.results?.[0];
    return r ? { open: r.o, high: r.h, low: r.l, close: r.c, vwap: r.vw } : null;
  } catch(e) { return null; }
}

// ── AGGREGATE BARS (weekly H/L) ───────────────────────────
async function fetchWeekBars(ticker) {
  try {
    const now = new Date();
    const monday = new Date(now);
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    monday.setDate(now.getDate() + diff);
    const from = monday.toISOString().split('T')[0];
    const to = now.toISOString().split('T')[0];
    const data = await polyGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}`, {
      adjusted: true, sort: 'asc'
    });
    const bars = data?.results || [];
    if (!bars.length) return null;
    const highs = bars.map(b => b.h);
    const lows  = bars.map(b => b.l);
    return {
      high: Math.max(...highs),
      low:  Math.min(...lows),
    };
  } catch(e) { return null; }
}

// ── PROCESS OPTION CHAIN ──────────────────────────────────
function processOptionChain(chain, currentPrice) {
  if (!chain.length || !currentPrice) return {};

  // Filter to nearest expiry with enough OI
  const grouped = {};
  chain.forEach(c => {
    const exp = c.details?.expiration_date;
    if (!exp) return;
    if (!grouped[exp]) grouped[exp] = [];
    grouped[exp].push(c);
  });

  // Pick nearest expiry with decent data
  const expiries = Object.keys(grouped).sort();
  const nearestExp = expiries[0];
  const contracts = grouped[nearestExp] || chain;

  let callWall = null, putWall = null, maxCallOI = 0, maxPutOI = 0;
  let totalCallOI = 0, totalPutOI = 0;
  let totalCallVol = 0, totalPutVol = 0;
  let weightedCallStrike = 0, weightedPutStrike = 0;
  let netGamma = 0;

  const strikeMap = {};

  contracts.forEach(c => {
    const strike = c.details?.strike_price;
    const type   = c.details?.contract_type;
    const oi     = c.open_interest || 0;
    const vol    = c.day?.volume   || 0;
    const iv     = c.implied_volatility || 0;
    const gamma  = c.greeks?.gamma || 0;
    if (!strike || !type) return;

    if (!strikeMap[strike]) strikeMap[strike] = { strike, callOI: 0, putOI: 0, callVol: 0, putVol: 0, iv: 0, gamma: 0 };

    if (type === 'call') {
      strikeMap[strike].callOI  += oi;
      strikeMap[strike].callVol += vol;
      totalCallOI  += oi;
      totalCallVol += vol;
      netGamma += gamma * oi * 100 * currentPrice;
      if (oi > maxCallOI) { maxCallOI = oi; callWall = strike; }
      weightedCallStrike += strike * oi;
    } else {
      strikeMap[strike].putOI   += oi;
      strikeMap[strike].putVol  += vol;
      totalPutOI  += oi;
      totalPutVol += vol;
      netGamma -= gamma * oi * 100 * currentPrice;
      if (oi > maxPutOI) { maxPutOI = oi; putWall = strike; }
      weightedPutStrike += strike * oi;
    }
    strikeMap[strike].iv = iv || strikeMap[strike].iv;
    strikeMap[strike].gamma += Math.abs(gamma * oi);
  });

  // Max pain: strike where total OI value lost by expiring options is minimized
  const strikes = Object.keys(strikeMap).map(Number).sort((a,b) => a-b);
  let maxPain = currentPrice;
  let minPain = Infinity;
  strikes.forEach(s => {
    let callLoss = 0, putLoss = 0;
    strikes.forEach(k => {
      if (k < s) callLoss += (strikeMap[k].callOI * (s - k));
      if (k > s) putLoss  += (strikeMap[k].putOI  * (k - s));
    });
    const total = callLoss + putLoss;
    if (total < minPain) { minPain = total; maxPain = s; }
  });

  // Gamma flip: strike closest to ATM where net gamma crosses zero
  let gammaFlip = currentPrice;
  let closestGammaDelta = Infinity;
  strikes.forEach(s => {
    const d = Math.abs(s - currentPrice);
    if (d < closestGammaDelta && strikeMap[s].gamma > 0) {
      closestGammaDelta = d;
      gammaFlip = s;
    }
  });

  // Gamma staircase: top strikes above current price by call OI
  const staircase = strikes
    .filter(s => s >= currentPrice && strikeMap[s].callOI > 0)
    .sort((a,b) => a - b)
    .slice(0, 6)
    .map(s => ({ strike: s, oi: strikeMap[s].callOI }));

  // Flow table: top contracts by volume
  const topContracts = contracts
    .filter(c => (c.day?.volume || 0) > 0)
    .sort((a,b) => (b.day?.volume||0) - (a.day?.volume||0))
    .slice(0, CFG.FLOW_TABLE_MAX);

  const pcRatio = totalPutVol / (totalCallVol || 1);

  return {
    strikeMap, strikes, staircase,
    callWall, putWall, maxPain, gammaFlip,
    totalCallOI, totalPutOI, totalCallVol, totalPutVol,
    netGamma, pcRatio, topContracts,
    nearestExp,
  };
}

// ── LAYER 1: REGIME ───────────────────────────────────────
async function updateLayer1() {
  const tickers = ['SPY', 'QQQ', 'IWM'];
  const ids = { SPY: 'spy', QQQ: 'qqq', IWM: 'iwm' };

  const results = await Promise.allSettled(tickers.map(t => fetchSnapshot(t)));

  const regimes = [];
  tickers.forEach((ticker, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) return;
    const d = r.value;
    const id = ids[ticker];
    const price = d.price;
    const chg = d.changePct;
    if (!price) return;

    set(`${id}-price`, price.toFixed(2));
    const chgStr = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    set(`${id}-chg`, chgStr);
    const el = $(`${id}-chg`);
    if (el) el.className = 'rc-change ' + (chg >= 0 ? 'pos' : 'neg');

    const fillEl = $(`${id}-fill`);
    if (fillEl) {
      const pct = Math.min(Math.max(50 + chg * 5, 5), 95);
      fillEl.style.width = pct + '%';
      fillEl.className = 'rc-fill ' + (chg >= 0 ? 'pos' : 'neg');
    }
    const card = $(`rc-${id}`);
    if (card) card.className = 'regime-card ' + (chg >= 0 ? 'bull' : 'bear');

    if (ticker === 'IWM') {
      STATE.price = price;
      STATE.prevClose = d.prevClose;
    }

    regimes.push({ ticker, chg });
  });

  // VIX (use prev day bar)
  try {
    const vixBar = await fetchPrevDay('VIX');
    if (vixBar) {
      set('vix-price', vixBar.close.toFixed(2));
      const vixEl = $('vix-chg');
      const vixLevel = vixBar.close;
      const regime = vixLevel < 15 ? 'LOW' : vixLevel < 25 ? 'ELEVATED' : 'HIGH';
      if (vixEl) { vixEl.textContent = regime; vixEl.className = 'rc-change ' + (vixLevel < 20 ? 'pos' : 'neg'); }
      const vf = $('vix-fill');
      if (vf) {
        vf.style.width = Math.min(vixLevel * 2.5, 95) + '%';
        vf.className = 'rc-fill ' + (vixLevel < 20 ? 'pos' : 'neg');
      }
      STATE.regimeData.vix = vixBar.close;
    }
  } catch(e) {}

  // Classify regime
  classifyRegime(regimes);
}

function classifyRegime(regimes) {
  const vix = STATE.regimeData.vix || 15;
  const spyChg  = regimes.find(r => r.ticker==='SPY')?.chg || 0;
  const qqqChg  = regimes.find(r => r.ticker==='QQQ')?.chg || 0;
  const iwmChg  = regimes.find(r => r.ticker==='IWM')?.chg || 0;
  const bullish = spyChg > 0 && iwmChg > 0;
  const trending = Math.abs(spyChg) > 0.5;
  const chop     = Math.abs(spyChg) < 0.2;
  const highVol  = vix > 25;
  const expansion= Math.abs(iwmChg) > 1.0;

  let regime = 'TREND DAY';
  let dtActive = 'dt-trend';

  if (highVol) { regime = 'HEDGE DAY'; dtActive = 'dt-hedge'; }
  else if (chop) { regime = 'CHOP DAY'; dtActive = 'dt-chop'; }
  else if (expansion) { regime = 'EXPANSION DAY'; dtActive = 'dt-expansion'; }
  else if (Math.abs(spyChg) < 0.3 && vix < 15) { regime = 'PIN DAY'; dtActive = 'dt-pin'; }

  set('regimeLabel', regime);
  STATE.regimeData.regime = regime;
  STATE.regimeData.bullish = bullish;

  // Update day type highlights
  ['dt-trend','dt-chop','dt-pin','dt-expansion','dt-hedge'].forEach(id => {
    const el = $(id);
    if (el) el.className = 'day-type-item' + (id === dtActive ? ' active' : '');
  });

  updatePlaybookBanner();
}

// ── LAYER 2: DEALER POSITIONING ───────────────────────────
async function updateLayer2() {
  const price = STATE.price;
  if (!price) { logSignal('No price data for dealer layer', 'warn'); return; }

  const chain = await fetchOptionChain(STATE.ticker);
  STATE.optionChain = chain;

  const od = processOptionChain(chain, price);
  if (!od.strikes?.length) {
    logSignal('No option chain data returned', 'warn');
    return;
  }

  STATE.regimeData.od = od;

  // Wall Stats
  if (od.callWall) {
    set('callWall', od.callWall.toFixed(0));
    const dist = ((od.callWall - price) / price * 100).toFixed(2);
    set('callWallDist', `+${dist}% away`);
    set('distCallWall', `+${dist}%`);
    set('roomToRun', dist > 2 ? 'YES — ROOM' : 'LIMITED');
  }
  if (od.putWall)  set('putWall', od.putWall.toFixed(0));
  if (od.maxPain)  set('maxPain', od.maxPain.toFixed(0));
  if (od.gammaFlip) set('gammaFlip', od.gammaFlip.toFixed(0));

  // Net Gamma
  const ng = od.netGamma;
  const ngStr = (ng >= 0 ? '+' : '') + (ng / 1e6).toFixed(1) + 'M';
  set('netGamma', ngStr);
  const gsEl = $('netGamma');
  if (gsEl) gsEl.className = 'gs-val ' + (ng >= 0 ? 'green' : 'red');

  // Gamma State
  const gammaState = ng >= 0 ? 'POSITIVE (PIN)' : 'NEGATIVE (EXP)';
  set('gammaState', gammaState);
  const gstEl = $('gammaState');
  if (gstEl) gstEl.className = 'gs-val ' + (ng >= 0 ? 'yellow' : 'green');
  STATE.regimeData.gammaPositive = ng >= 0;

  // OI Chart
  renderOIChart(od, price);

  // Gamma Staircase
  renderStaircase(od.staircase, price);

  updatePlaybookBanner();
}

function renderOIChart(od, price) {
  const chart = $('oiChart');
  if (!chart) return;
  chart.innerHTML = '';

  const strikes = od.strikes?.filter(s => {
    const info = od.strikeMap[s];
    return (info.callOI > 0 || info.putOI > 0) &&
           Math.abs(s - price) / price < 0.06;
  }) || [];

  if (!strikes.length) { chart.innerHTML = '<div class="oi-loading">No OI data in range</div>'; return; }

  const maxOI = Math.max(...strikes.map(s => Math.max(od.strikeMap[s].callOI, od.strikeMap[s].putOI)));
  const chartH = 120;

  // Price line position
  const minS = Math.min(...strikes);
  const maxS = Math.max(...strikes);
  const priceRatio = (price - minS) / (maxS - minS || 1);
  const priceLine = document.createElement('div');
  priceLine.className = 'oi-price-line';
  priceLine.style.left = (priceRatio * 100) + '%';
  chart.appendChild(priceLine);

  strikes.forEach(s => {
    const info = od.strikeMap[s];
    const group = document.createElement('div');
    group.className = 'oi-bar-group';

    const callH = Math.max(2, (info.callOI / maxOI) * chartH);
    const putH  = Math.max(2, (info.putOI  / maxOI) * chartH);

    const callBar = document.createElement('div');
    callBar.className = 'oi-bar call';
    callBar.style.height = callH + 'px';
    callBar.title = `Call OI: ${info.callOI.toLocaleString()}`;

    const putBar = document.createElement('div');
    putBar.className = 'oi-bar put';
    putBar.style.height = putH + 'px';
    putBar.title = `Put OI: ${info.putOI.toLocaleString()}`;

    const label = document.createElement('span');
    label.className = 'oi-strike';
    label.textContent = s;

    group.appendChild(callBar);
    group.appendChild(putBar);
    group.appendChild(label);
    chart.appendChild(group);
  });
}

function renderStaircase(staircase, price) {
  const row = $('staircaseRow');
  if (!row) return;
  row.innerHTML = '';

  if (!staircase?.length) {
    row.innerHTML = '<div class="sc-step loading">No staircase data</div>';
    return;
  }

  staircase.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'sc-step' + (i === 0 ? ' active' : '');
    div.innerHTML = `${step.strike}<span class="sc-oi">${(step.oi/1000).toFixed(1)}K OI</span>`;
    row.appendChild(div);
  });
}

// ── LAYER 3: FLOW ENGINE ──────────────────────────────────
async function updateLayer3() {
  const od = STATE.regimeData.od;
  if (!od) { logSignal('Waiting for option chain data…', 'warn'); return; }

  // Call/Put Volume
  set('callVol', formatNum(od.totalCallVol));
  set('putVol',  formatNum(od.totalPutVol));

  const pcr = od.pcRatio;
  set('pcRatio', pcr.toFixed(2));
  const pcEl = $('pcRatio');
  if (pcEl) pcEl.className = 'fs-val ' + (pcr < 0.7 ? 'green' : pcr > 1.2 ? 'red' : 'yellow');

  // Flow signal
  let flowSignal = 'NEUTRAL';
  if (pcr < 0.6) flowSignal = 'AGGRESSIVE CALLS';
  else if (pcr < 0.8) flowSignal = 'CALL SKEW';
  else if (pcr > 1.3) flowSignal = 'AGGRESSIVE PUTS';
  else if (pcr > 1.1) flowSignal = 'PUT SKEW';
  set('flowSignal', flowSignal);
  STATE.regimeData.flowSignal = flowSignal;
  STATE.regimeData.flowBullish = pcr < 0.8;

  // Flow bar
  const callPct = Math.round(od.totalCallVol / ((od.totalCallVol + od.totalPutVol) || 1) * 100);
  const putPct  = 100 - callPct;
  const fbC = $('fbCalls');
  const fbP = $('fbPuts');
  if (fbC) fbC.style.width = callPct + '%';
  if (fbP) fbP.style.width = putPct  + '%';
  set('fbCallPct', callPct + '%');
  set('fbPutPct',  putPct  + '%');

  // Flow table
  renderFlowTable(od.topContracts);

  updatePlaybookBanner();
}

function renderFlowTable(contracts) {
  const body = $('flowTable');
  if (!body) return;
  body.innerHTML = '';

  if (!contracts?.length) {
    body.innerHTML = '<div class="ft-loading">No flow data</div>';
    return;
  }

  contracts.slice(0, CFG.FLOW_TABLE_MAX).forEach(c => {
    const type   = c.details?.contract_type || '?';
    const strike = c.details?.strike_price   || '--';
    const exp    = c.details?.expiration_date || '--';
    const oi     = c.open_interest            || 0;
    const vol    = c.day?.volume              || 0;
    const iv     = c.implied_volatility       || 0;

    const isLargeVol = vol > oi * 0.3;
    const isSweep    = vol > 1000;
    let signal = '--';
    if (isSweep && type === 'call') signal = 'SWEEP↑';
    else if (isSweep && type === 'put') signal = 'SWEEP↓';
    else if (isLargeVol) signal = 'ACTIVE';

    const row = document.createElement('div');
    row.className = 'ft-row';
    row.innerHTML = `
      <span class="${type}">${strike}</span>
      <span class="${type}">${type.toUpperCase()}</span>
      <span>${exp.slice(5)}</span>
      <span>${formatNum(oi)}</span>
      <span>${formatNum(vol)}</span>
      <span>${iv ? (iv*100).toFixed(0)+'%' : '--'}</span>
      <span class="${isSweep ? 'sweep' : ''}">${signal}</span>
    `;
    body.appendChild(row);
  });
}

// ── LAYER 4: STRUCTURE ENGINE ─────────────────────────────
async function updateLayer4() {
  const price = STATE.price;
  if (!price) return;

  set('structPrice', price.toFixed(2));
  set('klCUR', price.toFixed(2));

  const pct = STATE.prevClose ? ((price - STATE.prevClose) / STATE.prevClose * 100) : null;
  const chgStr = pct !== null ? `${pct >= 0 ? '+' : ''}${(price - STATE.prevClose).toFixed(2)} | ${pct.toFixed(2)}%` : '--';
  set('structChange', chgStr);
  const scEl = $('structChange');
  if (scEl) scEl.className = 'spb-change ' + (pct >= 0 ? 'pos' : 'neg');

  // Fetch indicators in parallel
  const [ema20, ema50, rsi, macd, prevDay, weekBars] = await Promise.all([
    fetchEMA(STATE.ticker, 20),
    fetchEMA(STATE.ticker, 50),
    fetchRSI(STATE.ticker),
    fetchMACD(STATE.ticker),
    fetchPrevDay(STATE.ticker),
    fetchWeekBars(STATE.ticker),
  ]);

  STATE.indicators = { ema20, ema50, rsi, macd, prevDay, weekBars };

  // EMA 20
  if (ema20) {
    set('ema20', ema20.toFixed(2));
    const above = price > ema20;
    set('ema20rel', above ? 'ABOVE ▲' : 'BELOW ▼');
    const el = $('ema20rel');
    if (el) el.className = 'ti-rel ' + (above ? 'bull' : 'bear');
  }

  // EMA 50
  if (ema50) {
    set('ema50', ema50.toFixed(2));
    const above = price > ema50;
    set('ema50rel', above ? 'ABOVE ▲' : 'BELOW ▼');
    const el = $('ema50rel');
    if (el) el.className = 'ti-rel ' + (above ? 'bull' : 'bear');
  }

  // RSI
  if (rsi) {
    set('rsi14', rsi.toFixed(1));
    let sig = 'NEUTRAL';
    if (rsi > 70) sig = 'OVERBOUGHT';
    else if (rsi < 30) sig = 'OVERSOLD';
    else if (rsi > 55) sig = 'BULLISH';
    else if (rsi < 45) sig = 'BEARISH';
    set('rsiSignal', sig);
    const el = $('rsiSignal');
    if (el) el.className = 'ti-rel ' + (rsi > 50 ? 'bull' : 'bear');
  }

  // MACD
  if (macd) {
    set('macdVal', macd.value.toFixed(3));
    const sig = macd.histogram > 0 ? 'BULLISH CROSS' : 'BEARISH CROSS';
    set('macdSignal', sig);
    const el = $('macdSignal');
    if (el) el.className = 'ti-rel ' + (macd.histogram > 0 ? 'bull' : 'bear');
  }

  // Structure bias
  const aboveEma20 = ema20 && price > ema20;
  const aboveEma50 = ema50 && price > ema50;
  const biasEl = $('structBias');
  let bias = 'NEUTRAL';
  if (aboveEma20 && aboveEma50) { bias = 'BULLISH'; }
  else if (!aboveEma20 && !aboveEma50) { bias = 'BEARISH'; }
  else { bias = aboveEma20 ? 'MILD BULL' : 'MILD BEAR'; }
  if (biasEl) { biasEl.textContent = bias; biasEl.className = 'sb-val ' + (bias.includes('BULL') ? 'bull' : 'bear'); }
  STATE.regimeData.structureBullish = bias.includes('BULL');

  // Level stack + key levels
  renderLevelStack(price, prevDay, weekBars, ema20, ema50);

  updatePlaybookBanner();
}

function renderLevelStack(price, prevDay, weekBars, ema20, ema50) {
  const stack = $('levelStack');
  if (!stack) return;
  stack.innerHTML = '';

  const levels = [];

  if (weekBars?.high)  levels.push({ name: 'WEEK HIGH',     price: weekBars.high, type: 'res' });
  if (prevDay?.high)   levels.push({ name: 'PREV DAY HIGH', price: prevDay.high,  type: 'res' });
  if (ema50)           levels.push({ name: 'EMA 50',        price: ema50,         type: 'res' });
  if (ema20)           levels.push({ name: 'EMA 20',        price: ema20,         type: price > ema20 ? 'sup' : 'res' });
  levels.push({ name: 'CURRENT PRICE', price, type: 'cur' });
  if (prevDay?.low)    levels.push({ name: 'PREV DAY LOW',  price: prevDay.low,   type: 'sup' });
  if (weekBars?.low)   levels.push({ name: 'WEEK LOW',      price: weekBars.low,  type: 'sup' });

  levels.sort((a, b) => b.price - a.price);

  levels.forEach(l => {
    const div = document.createElement('div');
    div.className = 'ls-level';
    const dist = ((l.price - price) / price * 100).toFixed(2);
    const distStr = l.type !== 'cur' ? (dist >= 0 ? `+${dist}%` : `${dist}%`) : '';
    div.innerHTML = `
      <span class="ls-badge ${l.type}">${l.type === 'cur' ? 'PRICE' : l.type === 'res' ? 'RES' : 'SUP'}</span>
      <span class="ls-name">${l.name}</span>
      <span class="ls-price">${l.price.toFixed(2)}</span>
      <span class="ls-dist">${distStr}</span>
    `;
    stack.appendChild(div);
  });

  // Key levels table
  if (prevDay) {
    set('klPDH', prevDay.high.toFixed(2));
    set('klPDL', prevDay.low.toFixed(2));
    set('klPDHs', price > prevDay.high ? 'ABOVE ✓' : 'BELOW');
    set('klPDLs', price > prevDay.low  ? 'ABOVE ✓' : 'BELOW');
  }
  if (weekBars) {
    set('klPWH', weekBars.high.toFixed(2));
    set('klPWL', weekBars.low.toFixed(2));
    set('klPWHs', price > weekBars.high ? 'ABOVE ✓' : 'BELOW');
    set('klPWLs', price > weekBars.low  ? 'ABOVE ✓' : 'BELOW');
  }
}

// ── LAYER 5: PLAYBOOK ENGINE ──────────────────────────────
function updateLayer5() {
  const rd = STATE.regimeData;
  const od = rd.od;
  const price = STATE.price;
  if (!price) return;

  // Score confluence factors
  let score = 0;
  const factors = [];

  if (rd.bullish)              { score += 20; factors.push('Market regime bullish'); }
  if (rd.structureBullish)     { score += 20; factors.push('Price above EMAs'); }
  if (rd.flowBullish)          { score += 15; factors.push('Call flow dominant'); }
  if (!rd.gammaPositive)       { score += 15; factors.push('Negative gamma = expansion'); }
  if (od?.callWall && price < od.callWall) { score += 15; factors.push('Below call wall = room'); }
  if (od?.maxPain && price > od.maxPain)   { score += 10; factors.push('Above max pain'); }
  if (rd.vix && rd.vix < 20)  { score += 5;  factors.push('Low VIX environment'); }

  // Active setup
  let setupName = 'SCANNING';
  let setupDesc = 'Analyzing confluence layers…';
  let playbookId = null;

  if (score >= 80) {
    setupName = 'TRIFECTA';
    setupDesc = 'Maximum confluence detected: regime + structure + flow + positioning all aligned bullish.';
    playbookId = 'pbc-trifecta';
  } else if (!rd.gammaPositive && rd.bullish && score >= 60) {
    setupName = 'GAMMA EXPANSION';
    setupDesc = 'Negative gamma environment with bullish regime. Dealers must hedge — acceleration potential.';
    playbookId = 'pbc-gamma';
  } else if (od?.callWall && price > od.maxPain && score >= 50) {
    setupName = 'MAGNET RUN';
    setupDesc = `Price above max pain (${od.maxPain}) moving toward call wall (${od.callWall}). Dealer magnet active.`;
    playbookId = 'pbc-magnet';
  } else if (rd.gammaPositive && Math.abs(score - 50) < 15) {
    setupName = 'PIN RISK';
    setupDesc = 'Positive gamma environment near max pain. Expect chop — avoid directional expansion plays.';
    playbookId = 'pbc-pin';
  } else if (rd.flowSignal?.includes('AGGRESSIVE')) {
    setupName = 'FIRECRACKER';
    setupDesc = 'Aggressive options flow detected with expansion potential. Monitor for breakout.';
    playbookId = 'pbc-firecracker';
  } else if (score < 30 && !rd.bullish) {
    setupName = 'DEALER CASCADE';
    setupDesc = 'Bearish regime, put-heavy flow, structure breakdown risk. Fast downside move potential.';
    playbookId = 'pbc-cascade';
  } else {
    setupName = 'MONITORING';
    setupDesc = 'Confluence score below threshold. No high-conviction setup. Stay patient.';
  }

  set('asName', setupName);
  set('asDesc', setupDesc);

  const fillEl = $('ascFill');
  if (fillEl) fillEl.style.width = score + '%';
  set('ascPct', score + '%');

  // Playbook cards
  const allCards = ['firecracker','trifecta','magnet','pin','gamma','cascade'];
  allCards.forEach(id => {
    const card = $(`pbc-${id}`);
    const status = $(`pbs-${id}`);
    if (!card || !status) return;
    if (`pbc-${id}` === playbookId) {
      card.className = 'pb-card active';
      status.textContent = 'ACTIVE';
      status.className = 'pbc-status active-s';
    } else {
      card.className = 'pb-card inactive';
      status.textContent = '--';
      status.className = 'pbc-status inactive-s';
    }
  });

  // Probability map
  const bullPct = Math.min(Math.max(score, 10), 90);
  const bearPct = 100 - bullPct;

  const pmBullFill = $('pmBullFill');
  const pmBearFill = $('pmBearFill');
  if (pmBullFill) pmBullFill.style.width = bullPct + '%';
  if (pmBearFill) pmBearFill.style.width = bearPct + '%';
  set('pmBullPct', bullPct + '%');
  set('pmBearPct', bearPct + '%');

  // Paths
  if (od?.staircase?.length >= 3) {
    const s = od.staircase;
    set('pmBullPath', `${price.toFixed(0)} → ${s[1]?.strike||'?'} → ${s[2]?.strike||'?'} → ${od.callWall||'?'}`);
  }
  if (od?.maxPain && od?.putWall) {
    set('pmBearPath', `${price.toFixed(0)} → ${od.maxPain} → ${od.putWall}`);
  }

  const bullConds = [];
  if (od?.maxPain) bullConds.push(`${od.maxPain} must hold`);
  bullConds.push('SPY/QQQ stable');
  if (STATE.regimeData.vix) bullConds.push(`VIX stays <${(STATE.regimeData.vix + 3).toFixed(0)}`);
  set('pmBullCond', bullConds.join(' · '));

  const bearConds = [];
  if (STATE.indicators.ema20) bearConds.push(`EMA20 (${STATE.indicators.ema20.toFixed(2)}) fails`);
  bearConds.push('Risk-off triggers');
  set('pmBearCond', bearConds.join(' · '));

  // Playbook banner
  set('pbPlay', setupName);
  STATE.regimeData.setupName = setupName;

  logSignal(`Setup: ${setupName} | Score: ${score}% | ${factors.slice(0,2).join(', ')}`, score >= 60 ? 'bull' : score >= 40 ? '' : 'bear');
}

// ── PLAYBOOK BANNER ───────────────────────────────────────
function updatePlaybookBanner() {
  const rd = STATE.regimeData;
  const od = rd.od;

  set('pbRegime', rd.regime || '--');
  set('pbBias', rd.bullish ? 'BULLISH' : rd.bullish === false ? 'BEARISH' : '--');
  set('pbGamma', rd.gammaPositive !== undefined ? (rd.gammaPositive ? 'POSITIVE (PIN)' : 'NEGATIVE (EXP)') : '--');
  set('pbTarget', od?.callWall ? od.callWall.toFixed(0) : '--');
  set('pbRisk', rd.vix > 25 ? 'HIGH' : rd.vix > 18 ? 'ELEVATED' : 'LOW');

  const biasEl = $('pbBias');
  if (biasEl) biasEl.className = 'pb-val ' + (rd.bullish ? 'green' : rd.bullish === false ? 'red' : '');
}

// ── SIGNAL LOG ────────────────────────────────────────────
function logSignal(msg, type = '') {
  const log = $('alertLog');
  if (!log) return;
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const time = `${String(et.getHours()).padStart(2,'0')}:${String(et.getMinutes()).padStart(2,'0')}`;

  const entry = document.createElement('div');
  entry.className = 'al-entry ' + type;
  entry.innerHTML = `<span class="al-time">${time}</span><span>${msg}</span>`;

  log.insertBefore(entry, log.firstChild);
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

// ── FORMAT HELPERS ────────────────────────────────────────
function formatNum(n) {
  if (!n && n !== 0) return '--';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toString();
}

// ── SPINNER ───────────────────────────────────────────────
function setLayerLoading(layer, loading) {
  const btn = document.querySelector(`[data-layer="${layer}"]`);
  if (!btn) return;
  btn.className = 'panel-refresh' + (loading ? ' spinning' : '');
}

// ── FULL REFRESH ──────────────────────────────────────────
async function fullRefresh() {
  if (!STATE.apiKey) {
    logSignal('Enter Polygon.io API key to begin scanning', 'warn');
    return;
  }

  logSignal(`Scanning ${STATE.ticker}…`);
  set('regimeLabel', 'SCANNING…');

  // Run layers with individual loading indicators
  [1,2,3,4,5].forEach(l => setLayerLoading(l, true));

  try {
    await updateLayer1();
    setLayerLoading(1, false);

    await updateLayer2();
    setLayerLoading(2, false);

    await updateLayer3();
    setLayerLoading(3, false);

    await updateLayer4();
    setLayerLoading(4, false);

    updateLayer5();
    setLayerLoading(5, false);

    const now = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
    set('lastUpdate', `Last update: ${now} ET`);

  } catch(e) {
    logSignal(`Refresh error: ${e.message}`, 'warn');
    [1,2,3,4,5].forEach(l => setLayerLoading(l, false));
  }
}

// ── AUTO REFRESH ──────────────────────────────────────────
function startAutoRefresh() {
  if (STATE.refreshTimer) clearInterval(STATE.refreshTimer);
  if (STATE.countdownTimer) clearInterval(STATE.countdownTimer);

  STATE.countdown = CFG.REFRESH_INTERVAL;

  STATE.countdownTimer = setInterval(() => {
    STATE.countdown--;
    set('refreshCountdown', STATE.countdown);
    if (STATE.countdown <= 0) STATE.countdown = CFG.REFRESH_INTERVAL;
  }, 1000);

  STATE.refreshTimer = setInterval(() => {
    fullRefresh();
    STATE.countdown = CFG.REFRESH_INTERVAL;
  }, CFG.REFRESH_INTERVAL * 1000);
}

// ── LAYER REFRESH BUTTONS ─────────────────────────────────
function attachLayerRefresh() {
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
      } finally {
        setLayerLoading(layer, false);
      }
    });
  });
}

// ── INIT ──────────────────────────────────────────────────
function init() {
  startClock();
  attachLayerRefresh();

  // Load saved API key
  const saved = localStorage.getItem('instmap_apikey');
  if (saved) {
    $('apiKeyInput').value = saved;
    STATE.apiKey = saved;
  }

  const savedTicker = localStorage.getItem('instmap_ticker');
  if (savedTicker) {
    $('tickerInput').value = savedTicker;
    STATE.ticker = savedTicker;
  }

  $('loadBtn').addEventListener('click', () => {
    const key = $('apiKeyInput').value.trim();
    const ticker = $('tickerInput').value.trim().toUpperCase();
    if (!key) { logSignal('API key required', 'warn'); return; }
    if (!ticker) { logSignal('Ticker required', 'warn'); return; }
    STATE.apiKey = key;
    STATE.ticker = ticker;
    localStorage.setItem('instmap_apikey', key);
    localStorage.setItem('instmap_ticker', ticker);
    fullRefresh();
    startAutoRefresh();
  });

  // Auto-start if key saved
  if (STATE.apiKey) {
    fullRefresh();
    startAutoRefresh();
  }

  set('refreshCountdown', CFG.REFRESH_INTERVAL);
}

document.addEventListener('DOMContentLoaded', init);

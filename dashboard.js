/* ═══════════════════════════════════════════════════════════
   INSTMAP v2.3 — Final Optimized Edition
   
   FIXES IN THIS VERSION:
   ✓ FIRECRACKER now correctly uses flow direction (not name)
   ✓ Confluence score suppressed when flow is bearish
   ✓ MACD shows histogram value (not line value)
   ✓ Price change labeled "PREV CLOSE" when market closed
   ✓ Put staircase row bug fixed
   ✓ Signal log height increased
   ✓ Market closed session banner auto-shows
   ✓ API call counter in footer
   ✓ VIX fallback display
   ✓ Level stack ordering guaranteed
   ✓ Directional confluence: bearish flow suppresses bull setups
   ✓ Room-to-run dynamic color
   ═══════════════════════════════════════════════════════════ */

'use strict';

const CFG = {
  POLYGON_BASE:     'https://api.polygon.io',
  POLYGON_WS:       'wss://socket.polygon.io/options',
  REFRESH_INTERVAL: 120,
  CALL_GAP_MS:      420,
  FLOW_TABLE_MAX:   25,
  DEFAULT_TICKER:   'IWM',
  RETRY_DELAY_MS:   2500,
  MAX_RETRIES:      2,
};

const STATE = {
  apiKey: '', ticker: CFG.DEFAULT_TICKER,
  price: null, prevClose: null,
  optionChain: [], indicators: {},
  marketOpen: false, regimeData: {},
  countdown: CFG.REFRESH_INTERVAL,
  refreshTimer: null, cdTimer: null,
  ws: null, wsConnected: false,
  cache: {}, isRefreshing: false,
  apiCallCount: 0,
  chainUnderlyingPrice: null,
};

const $   = id  => document.getElementById(id);
const set = (id, v) => { const e=$(id); if(e) e.textContent=v; };

// ── API THROTTLE QUEUE ─────────────────────────────────────
const _queue = (() => {
  let last = 0;
  return async fn => {
    const gap = Math.max(0, last + CFG.CALL_GAP_MS - Date.now());
    if (gap > 0) await sleep(gap);
    last = Date.now();
    STATE.apiCallCount++;
    set('apiCounter', 'API calls: ' + STATE.apiCallCount);
    return fn();
  };
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function polyGet(path, params={}, retries=CFG.MAX_RETRIES) {
  return _queue(async () => {
    const url = new URL(CFG.POLYGON_BASE + path);
    url.searchParams.set('apiKey', STATE.apiKey);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    for (let i=0; i<=retries; i++) {
      const res = await fetch(url.toString());
      if (res.status === 429) { if(i<retries){await sleep(CFG.RETRY_DELAY_MS*(i+1));continue;} throw new Error('429 '+path); }
      if (!res.ok) throw new Error(res.status+' '+path);
      return res.json();
    }
  });
}

async function cachedGet(key, path, params={}, ttl=300000) {
  const e = STATE.cache[key];
  if (e && Date.now()-e.ts < ttl) return e.data;
  const data = await polyGet(path, params);
  STATE.cache[key] = { data, ts: Date.now() };
  return data;
}

// ── CLOCK ──────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    const et  = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
    const pad = n => String(n).padStart(2,'0');
    set('clock', `${pad(et.getHours())}:${pad(et.getMinutes())}:${pad(et.getSeconds())} ET`);
    const h=et.getHours(), m=et.getMinutes(), d=et.getDay();
    const open = d>=1&&d<=5&&(h>9||(h===9&&m>=30))&&h<16;
    STATE.marketOpen = open;
    const el=$('mktStatus');
    if(el){ el.textContent=open?'● MARKET OPEN':'● MARKET CLOSED'; el.className='market-status '+(open?'open':'closed'); }
    // Session notice bar
    const sn=$('sessionNotice');
    if(sn) sn.style.display = open ? 'none' : 'flex';
  };
  tick(); setInterval(tick,1000);
}

// ══════════════════════════════════════════════════════════
// DATA FETCHERS
// ══════════════════════════════════════════════════════════
async function fetchPrevDay(ticker) {
  try {
    const d = await cachedGet('prev_'+ticker, `/v2/aggs/ticker/${ticker}/prev`, {adjusted:true}, 300000);
    const r = d?.results?.[0];
    return r ? {open:r.o, high:r.h, low:r.l, close:r.c, vwap:r.vw, volume:r.v} : null;
  } catch(e) { logSignal(`prevDay ${ticker}: ${e.message}`, 'warn'); return null; }
}

async function fetchOptionChain(underlying) {
  try {
    const all = [];
    const firstUrl = new URL(`${CFG.POLYGON_BASE}/v3/snapshot/options/${underlying}`);
    firstUrl.searchParams.set('limit','250');
    firstUrl.searchParams.set('apiKey', STATE.apiKey);
    await sleep(CFG.CALL_GAP_MS); // honor throttle
    STATE.apiCallCount++;
    set('apiCounter','API calls: '+STATE.apiCallCount);

    const r1 = await fetch(firstUrl.toString());
    if (!r1.ok) { logSignal(`Chain: ${r1.status}`, 'warn'); return []; }
    const d1 = await r1.json();
    if (d1.results) all.push(...d1.results);

    // Extract underlying price
    STATE.chainUnderlyingPrice = null;
    const first = d1.results?.[0];
    if (first?.underlying_asset?.price) STATE.chainUnderlyingPrice = first.underlying_asset.price;

    // Pages 2-4
    let nextUrl = d1.next_url;
    for (let p=1; p<4 && nextUrl; p++) {
      await sleep(CFG.CALL_GAP_MS);
      STATE.apiCallCount++;
      set('apiCounter','API calls: '+STATE.apiCallCount);
      const sep = nextUrl.includes('?') ? '&' : '?';
      const res = await fetch(nextUrl + sep + 'apiKey=' + STATE.apiKey);
      if (!res.ok) break;
      const data = await res.json();
      if (data.results) all.push(...data.results);
      nextUrl = data.next_url;
    }
    return all;
  } catch(e) { logSignal('Chain: '+e.message,'warn'); return []; }
}

async function fetchEMA(ticker, period) {
  try {
    const d = await cachedGet(`ema${period}_${ticker}`, `/v1/indicators/ema/${ticker}`,
      {timespan:'day', window:period, limit:3, series_type:'close'}, 300000);
    const v = d?.results?.values;
    return v?.length ? {current:v[0].value, prev:v[1]?.value, prev2:v[2]?.value} : null;
  } catch(_) { return null; }
}

async function fetchRSI(ticker) {
  try {
    const d = await cachedGet('rsi_'+ticker, `/v1/indicators/rsi/${ticker}`,
      {timespan:'day', window:14, limit:2, series_type:'close'}, 300000);
    const v = d?.results?.values;
    return v?.length ? {current:v[0].value, prev:v[1]?.value} : null;
  } catch(_) { return null; }
}

async function fetchMACD(ticker) {
  try {
    const d = await cachedGet('macd_'+ticker, `/v1/indicators/macd/${ticker}`,
      {timespan:'day', short_window:12, long_window:26, signal_window:9, limit:2, series_type:'close'}, 300000);
    const vals = d?.results?.values;
    if (!vals?.length) return null;
    const v=vals[0], prev=vals[1];
    return { value:v.value, signal:v.signal, histogram:v.histogram,
             prevHistogram: prev?.histogram ?? null };
  } catch(_) { return null; }
}

// ── OPTION CHAIN PROCESSING ───────────────────────────────
function processChain(chain, price) {
  if (!chain.length || !price) return null;

  const grouped = {};
  chain.forEach(c => {
    const exp = c.details?.expiration_date; if(!exp) return;
    if(!grouped[exp]) grouped[exp]=[];
    grouped[exp].push(c);
  });
  const expiries = Object.keys(grouped).sort();
  const wallContracts = expiries.slice(0,2).flatMap(e=>grouped[e]);
  const flowContracts = expiries.slice(0,3).flatMap(e=>grouped[e]);

  const strikeMap = {};
  let totalCallOI=0, totalPutOI=0, totalCallVol=0, totalPutVol=0, netGamma=0;

  wallContracts.forEach(c => {
    const strike=c.details?.strike_price, type=c.details?.contract_type;
    const oi=c.open_interest||0, vol=c.day?.volume||0;
    const gamma=c.greeks?.gamma||0, iv=c.implied_volatility||0;
    if (!strike||!type) return;
    if (!strikeMap[strike]) strikeMap[strike]={strike,callOI:0,putOI:0,callVol:0,putVol:0,gamma:0,iv:0,callIV:0,putIV:0};
    if (type==='call') {
      strikeMap[strike].callOI+=oi; strikeMap[strike].callVol+=vol;
      strikeMap[strike].callIV=iv||strikeMap[strike].callIV;
      totalCallOI+=oi; totalCallVol+=vol; netGamma+=gamma*oi*100*price;
    } else {
      strikeMap[strike].putOI+=oi; strikeMap[strike].putVol+=vol;
      strikeMap[strike].putIV=iv||strikeMap[strike].putIV;
      totalPutOI+=oi; totalPutVol+=vol; netGamma-=gamma*oi*100*price;
    }
    strikeMap[strike].gamma+=Math.abs(gamma*oi);
    strikeMap[strike].iv=iv||strikeMap[strike].iv;
  });

  const strikes = Object.keys(strikeMap).map(Number).sort((a,b)=>a-b);

  // Call / Put walls
  let callWall=null, putWall=null, maxCallOI=0, maxPutOI=0;
  strikes.forEach(s => {
    if(strikeMap[s].callOI>maxCallOI){maxCallOI=strikeMap[s].callOI;callWall=s;}
    if(strikeMap[s].putOI >maxPutOI) {maxPutOI =strikeMap[s].putOI; putWall =s;}
  });

  // Max pain
  let maxPain=price, minLoss=Infinity;
  strikes.forEach(s => {
    let loss=0;
    strikes.forEach(k => {
      loss += strikeMap[k].callOI*Math.max(0,s-k);
      loss += strikeMap[k].putOI *Math.max(0,k-s);
    });
    if(loss<minLoss){minLoss=loss;maxPain=s;}
  });

  // Gamma flip
  let gammaFlip=price, bestGScore=0;
  strikes.forEach(s => {
    const sc=strikeMap[s].gamma/(Math.abs(s-price)+1);
    if(sc>bestGScore){bestGScore=sc;gammaFlip=s;}
  });

  // Upside staircase (calls above price)
  const staircase = strikes
    .filter(s=>s>=price&&strikeMap[s].callOI>0)
    .sort((a,b)=>a-b).slice(0,6)
    .map(s=>({strike:s,oi:strikeMap[s].callOI}));

  // Downside staircase (puts below price)
  const putStaircase = strikes
    .filter(s=>s<=price&&strikeMap[s].putOI>0)
    .sort((a,b)=>b-a).slice(0,4)
    .map(s=>({strike:s,oi:strikeMap[s].putOI}));

  // IV skew: compare ATM-ish put IV vs call IV
  const atmStrikes = strikes.filter(s=>Math.abs(s-price)/price<0.03);
  let avgCallIV=0, avgPutIV=0, skewCount=0;
  atmStrikes.forEach(s => {
    if(strikeMap[s].callIV>0){avgCallIV+=strikeMap[s].callIV;skewCount++;}
    if(strikeMap[s].putIV>0) avgPutIV+=strikeMap[s].putIV;
  });
  if(skewCount>0){avgCallIV/=skewCount;avgPutIV/=skewCount;}
  const ivSkew = avgPutIV && avgCallIV ? avgPutIV - avgCallIV : 0; // positive = put IV > call IV = bearish skew

  // Unusual volume contracts
  const unusualContracts = flowContracts
    .filter(c=>{const r=(c.day?.volume||0)/(c.open_interest||1);return r>0.4&&(c.day?.volume||0)>200;})
    .sort((a,b)=>(b.day?.volume||0)/(b.open_interest||1)-(a.day?.volume||0)/(a.open_interest||1))
    .slice(0,3);

  const topContracts = flowContracts
    .filter(c=>(c.day?.volume||0)>0)
    .sort((a,b)=>(b.day?.volume||0)-(a.day?.volume||0))
    .slice(0,CFG.FLOW_TABLE_MAX);

  return {
    strikeMap, strikes, staircase, putStaircase, topContracts, unusualContracts,
    callWall, putWall, maxPain, gammaFlip,
    totalCallOI, totalPutOI, totalCallVol, totalPutVol,
    netGamma, ivSkew,
    pcVolRatio: totalPutVol/(totalCallVol||1),
    pcOIRatio:  totalPutOI/(totalCallOI||1),
    nearestExp: expiries[0], allExpiries: expiries,
  };
}

// ══════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════
function connectWebSocket() {
  if (!STATE.apiKey || STATE.ws) return;
  try {
    const ws = new WebSocket(CFG.POLYGON_WS);
    STATE.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({action:'auth',params:STATE.apiKey}));
    ws.onmessage = e => {
      let msgs; try{msgs=JSON.parse(e.data);}catch(_){return;}
      msgs.forEach(msg => {
        if (msg.ev==='status'&&msg.status==='auth_success') {
          ws.send(JSON.stringify({action:'subscribe',params:`AM.O:${STATE.ticker}*`}));
          STATE.wsConnected=true;
          logSignal('WS live — '+STATE.ticker+' option stream active','bull');
          updateWSBadge(true);
        }
        if (msg.ev==='AM') {
          flashWSPulse();
          if (msg.underlying_price) {
            STATE.price = msg.underlying_price;
            set('structPrice', STATE.price.toFixed(2));
            set('iwm-price', STATE.price.toFixed(2));
          }
        }
      });
    };
    ws.onerror = () => updateWSBadge(false);
    ws.onclose = () => { STATE.wsConnected=false; STATE.ws=null; updateWSBadge(false); };
  } catch(e) { logSignal('WS: '+e.message,'warn'); }
}

function updateWSBadge(on) {
  const el=$('wsStatus');
  if(el){ el.textContent=on?'◉ WS LIVE':'◎ WS OFF'; el.className='ws-status'+(on?' connected':''); }
}
function flashWSPulse() {
  const el=$('wsLive');
  if(el){ el.style.opacity='1'; setTimeout(()=>{if(el)el.style.opacity='0.3';},250); }
}

// ══════════════════════════════════════════════════════════
// LAYER 1 — REGIME ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer1() {
  const defs=[{sym:'SPY',id:'spy'},{sym:'QQQ',id:'qqq'},{sym:STATE.ticker,id:'iwm'}];
  const prices={};

  for (const td of defs) {
    const pd = await fetchPrevDay(td.sym);
    prices[td.sym]=pd;
    if(pd&&td.sym===STATE.ticker){ if(!STATE.price)STATE.price=pd.close; STATE.prevClose=pd.close; }
    renderRegimeCard(td,pd);
  }
  await fetchVIX();
  classifyRegime(prices);
  updatePlaybookBanner();
}

async function fetchVIX() {
  try {
    const d=await cachedGet('prev_VIX','/v2/aggs/ticker/VIX/prev',{adjusted:true},300000);
    const r=d?.results?.[0]; if(!r) return;
    const c=r.c;
    set('vix-price',c.toFixed(2));
    const label=c<13?'CALM':c<18?'NORMAL':c<25?'ELEVATED':c<35?'HIGH':'EXTREME';
    const chgEl=$('vix-chg');
    if(chgEl){chgEl.textContent=label;chgEl.className='rc-change '+(c<20?'pos':'neg');}
    const fill=$('vix-fill');
    if(fill){fill.style.width=Math.min(c*2.5,95)+'%';fill.className='rc-fill '+(c<20?'pos':'neg');}
    const card=$('rc-vix');
    if(card)card.className='regime-card '+(c<20?'bull':'bear');
    STATE.regimeData.vix=c;
  } catch(e){ set('vix-price','--'); logSignal('VIX: '+e.message,'warn'); }
}

function renderRegimeCard(td, pd) {
  const close=pd?.close??null, open=pd?.open??null;
  const pct=(close&&open)?((close-open)/open*100):0;
  set(`${td.id}-price`, close?close.toFixed(2):'--');
  const chgEl=$(`${td.id}-chg`);
  if(chgEl){ chgEl.textContent=close?(pct>=0?'+':'')+pct.toFixed(2)+'%':'--'; chgEl.className='rc-change '+(pct>=0?'pos':'neg'); }
  const fill=$(`${td.id}-fill`);
  if(fill){ fill.style.width=Math.min(Math.max(50+pct*4,5),95)+'%'; fill.className='rc-fill '+(pct>=0?'pos':'neg'); }
  const card=$(`rc-${td.id}`);
  if(card) card.className='regime-card '+(pct>=0?'bull':'bear');
}

function classifyRegime(prices) {
  const vix=STATE.regimeData.vix||16;
  const spy=prices['SPY'], qqq=prices['QQQ'], prim=prices[STATE.ticker];
  const spyChg  = spy  ? ((spy.close -spy.open) /spy.open *100) : 0;
  const qqqChg  = qqq  ? ((qqq.close -qqq.open) /qqq.open *100) : 0;
  const primChg = prim ? ((prim.close-prim.open)/prim.open*100) : 0;
  const bullish = spyChg>0 && primChg>0;
  const chop    = Math.abs(spyChg)<0.2 && vix<18;
  const expand  = Math.abs(primChg)>0.8;
  const highVol = vix>25;

  let regime='TREND DAY', dtId='dt-trend';
  if(highVol)   {regime='HEDGE DAY';     dtId='dt-hedge';}
  else if(chop) {regime='CHOP DAY';      dtId='dt-chop';}
  else if(expand){regime='EXPANSION DAY';dtId='dt-expansion';}
  else if(Math.abs(spyChg)<0.4){regime='PIN DAY';dtId='dt-pin';}

  set('regimeLabel',regime);
  STATE.regimeData.regime=regime; STATE.regimeData.bullish=bullish; STATE.regimeData.spyChg=spyChg;
  ['dt-trend','dt-chop','dt-pin','dt-expansion','dt-hedge'].forEach(id=>{
    const el=$(id); if(el)el.className='day-type-item'+(id===dtId?' active':'');
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 2 — DEALER POSITIONING
// ══════════════════════════════════════════════════════════
async function updateLayer2() {
  const chain = await fetchOptionChain(STATE.ticker);
  STATE.optionChain = chain;

  if (STATE.chainUnderlyingPrice) {
    STATE.price = STATE.chainUnderlyingPrice;
    logSignal(`Live price: $${STATE.price.toFixed(2)} (from options chain)`, 'bull');
  }

  const price = STATE.price;
  if (!price) { logSignal('No price — check ticker & API key', 'warn'); return; }
  if (!chain.length) { logSignal('Option chain empty', 'warn'); return; }

  const od = processChain(chain, price);
  if (!od) return;
  STATE.regimeData.od = od;

  const fmt = v => v!=null ? v.toFixed(0) : '--';
  set('callWall',fmt(od.callWall)); set('maxPain',fmt(od.maxPain));
  set('putWall', fmt(od.putWall));  set('gammaFlip',fmt(od.gammaFlip));

  if (od.callWall) {
    const d=((od.callWall-price)/price*100);
    set('callWallDist',(d>=0?'+':'')+d.toFixed(2)+'% away');
    set('distCallWall',(d>=0?'+':'')+d.toFixed(2)+'%');
    // Dynamic color for room-to-run
    const rtrEl=$('roomToRun'), label=d>5?'CLEAR':d>2?'OPEN':d>0.5?'TIGHT':'AT WALL';
    if(rtrEl){ rtrEl.textContent=label; rtrEl.className='gs-val '+(d>2?'green':d>0.5?'yellow':'red'); }
  }
  if (od.putWall) {
    const d=((od.putWall-price)/price*100);
    set('putWallDist',(d>=0?'+':'')+d.toFixed(2)+'% away');
  }

  // Net gamma
  const ng=od.netGamma;
  set('netGamma',(ng>=0?'+':'')+( ng/1e6).toFixed(2)+'M');
  const ngEl=$('netGamma'); if(ngEl)ngEl.className='gs-val '+(ng>=0?'yellow':'green');
  set('gammaState',ng>=0?'POSITIVE (PIN)':'NEGATIVE (EXP)');
  STATE.regimeData.gammaPositive=ng>=0;

  // IV Skew badge
  const ivSkewEl=$('ivSkewBadge');
  if(ivSkewEl && od.ivSkew!==0) {
    const skewAbs=Math.abs(od.ivSkew*100).toFixed(1);
    if(od.ivSkew>0.02) { ivSkewEl.textContent='PUT SKEW +'+skewAbs+'%'; ivSkewEl.className='skew-badge bear'; }
    else if(od.ivSkew<-0.02) { ivSkewEl.textContent='CALL SKEW '+skewAbs+'%'; ivSkewEl.className='skew-badge bull'; }
    else { ivSkewEl.textContent='IV NEUTRAL'; ivSkewEl.className='skew-badge neutral'; }
    STATE.regimeData.bearishSkew = od.ivSkew > 0.02;
  }

  if(od.nearestExp) set('nearestExp','EXP: '+od.nearestExp);
  const expEl=$('allExpiries');
  if(expEl) expEl.textContent=od.allExpiries.slice(0,4).join('  ·  ');

  renderOIChart(od, price);
  renderStaircase(od.staircase, od.putStaircase, price);
  updatePlaybookBanner();
}

function renderOIChart(od, price) {
  const chart=$('oiChart'); if(!chart) return;
  chart.innerHTML='';
  const nearby=od.strikes.filter(s=>{
    const i=od.strikeMap[s];
    return (i.callOI>0||i.putOI>0)&&Math.abs(s-price)/price<0.10;
  });
  if(!nearby.length){chart.innerHTML='<div class="oi-loading">No OI within 10% of price</div>';return;}

  const maxOI=Math.max(...nearby.map(s=>Math.max(od.strikeMap[s].callOI,od.strikeMap[s].putOI)));
  const chartH=140, minS=nearby[0], maxS=nearby[nearby.length-1], span=(maxS-minS)||1;

  // Price line
  const pPct=((price-minS)/span*100);
  const pl=document.createElement('div');
  pl.className='oi-price-line'; pl.style.left=Math.max(0.5,Math.min(99.5,pPct))+'%';
  pl.title='Price: $'+price.toFixed(2); chart.appendChild(pl);

  // Max pain line
  if(od.maxPain>=minS&&od.maxPain<=maxS){
    const mpPct=((od.maxPain-minS)/span*100);
    const mp=document.createElement('div');
    mp.className='oi-pain-line'; mp.style.left=Math.max(0,Math.min(99,mpPct))+'%';
    mp.title='Max Pain: $'+od.maxPain; chart.appendChild(mp);
  }

  nearby.forEach(s=>{
    const info=od.strikeMap[s];
    const group=document.createElement('div');
    group.className='oi-bar-group';
    group.title=`$${s}  C:${formatNum(info.callOI)}  P:${formatNum(info.putOI)}`;
    const callH=Math.max(3,(info.callOI/maxOI)*chartH);
    const putH =Math.max(3,(info.putOI /maxOI)*chartH);
    const cb=document.createElement('div');
    cb.className='oi-bar call'+(s===od.callWall?' wall':'');
    cb.style.height=callH+'px';
    const pb=document.createElement('div');
    pb.className='oi-bar put'+(s===od.putWall?' wall':'');
    pb.style.height=putH+'px';
    const lbl=document.createElement('span');
    lbl.className='oi-strike'; lbl.textContent=s;
    group.appendChild(cb); group.appendChild(pb); group.appendChild(lbl);
    chart.appendChild(group);
  });
}

function renderStaircase(staircase, putStaircase, price) {
  // Call staircase
  const row=$('staircaseRow'); if(!row) return;
  row.innerHTML='';
  if(!staircase?.length){ row.innerHTML='<div class="sc-step loading">No upside OI</div>'; }
  else {
    staircase.forEach((step,i)=>{
      const div=document.createElement('div');
      div.className='sc-step'+(i===0?' active':'');
      const pct=((step.strike-price)/price*100).toFixed(1);
      div.innerHTML=`${step.strike}<span class="sc-oi">${(step.oi/1000).toFixed(1)}K</span><span class="sc-pct">+${pct}%</span>`;
      row.appendChild(div);
    });
  }

  // Put staircase — SEPARATE row (bug fix: was appending to call row)
  const putRow=$('putStaircaseRow'); if(!putRow) return;
  putRow.innerHTML='';
  if(!putStaircase?.length){ putRow.innerHTML='<div class="sc-step loading">No downside OI</div>'; return; }
  putStaircase.forEach((step,i)=>{
    const div=document.createElement('div');
    div.className='sc-step put-step'+(i===0?' active':'');
    const pct=((step.strike-price)/price*100).toFixed(1);
    div.innerHTML=`${step.strike}<span class="sc-oi">${(step.oi/1000).toFixed(1)}K</span><span class="sc-pct red">${pct}%</span>`;
    putRow.appendChild(div); // ← FIXED: putRow not row
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 3 — FLOW ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer3() {
  const od=STATE.regimeData.od;
  if(!od){logSignal('No OI for flow','warn');return;}

  set('callVol',formatNum(od.totalCallVol)); set('putVol',formatNum(od.totalPutVol));
  set('totalCallOI',formatNum(od.totalCallOI)); set('totalPutOI',formatNum(od.totalPutOI));
  set('oiPCRatio',od.pcOIRatio.toFixed(2));

  const pcr=od.pcVolRatio;
  set('pcRatio',pcr.toFixed(2));
  const pEl=$('pcRatio');
  if(pEl) pEl.className='fs-val '+(pcr<0.7?'green':pcr>1.2?'red':'yellow');

  let sig='NEUTRAL', flowBull=false, flowBear=false;
  if      (pcr<0.45){sig='AGGRESSIVE CALLS';flowBull=true;}
  else if (pcr<0.65){sig='STRONG CALL BIAS';flowBull=true;}
  else if (pcr<0.85){sig='CALL SKEW';       flowBull=true;}
  else if (pcr>1.5) {sig='AGGRESSIVE PUTS'; flowBear=true;}
  else if (pcr>1.2) {sig='PUT SKEW';        flowBear=true;}
  else if (pcr>1.0) {sig='MILD PUT BIAS';   flowBear=true;}
  set('flowSignal',sig);
  STATE.regimeData.flowSignal=sig;
  STATE.regimeData.flowBullish=flowBull;
  STATE.regimeData.flowBearish=flowBear;

  // Flow balance bar
  const total=(od.totalCallVol+od.totalPutVol)||1;
  const callP=Math.round(od.totalCallVol/total*100), putP=100-callP;
  const fc=$('fbCalls'),fp=$('fbPuts');
  if(fc)fc.style.width=callP+'%'; if(fp)fp.style.width=putP+'%';
  set('fbCallPct',callP+'%'); set('fbPutPct',putP+'%');

  // Alert on unusual contracts
  if(od.unusualContracts?.length){
    const top=od.unusualContracts[0];
    const type=top.details?.contract_type, strike=top.details?.strike_price;
    const vol=top.day?.volume||0, oi=top.open_interest||1;
    logSignal(`UNUSUAL: $${strike} ${type?.toUpperCase()} — vol/OI ${(vol/oi).toFixed(1)}x (${formatNum(vol)} contracts)`, type==='call'?'bull':'bear');
  }

  renderFlowTable(od.topContracts);
  updatePlaybookBanner();
}

function renderFlowTable(contracts) {
  const body=$('flowTable'); if(!body) return;
  body.innerHTML='';
  if(!contracts?.length){body.innerHTML='<div class="ft-loading">No volume — market may be closed</div>';return;}
  contracts.forEach(c=>{
    const type=c.details?.contract_type||'?', strike=c.details?.strike_price||'--';
    const exp=c.details?.expiration_date||'--', oi=c.open_interest||0;
    const vol=c.day?.volume||0, iv=c.implied_volatility||0;
    const ratio=vol/(oi||1), isSweep=vol>300&&ratio>0.25;
    const isBlock=vol>1500&&ratio>0.1, isLarge=vol>5000;
    const isUnusual=ratio>0.5&&vol>100&&!isSweep&&!isBlock;
    let signal='--';
    if(isLarge&&type==='call')  signal='⚡BLOCK↑';
    else if(isLarge&&type==='put') signal='⚡BLOCK↓';
    else if(isSweep&&type==='call')signal='SWEEP↑';
    else if(isSweep&&type==='put') signal='SWEEP↓';
    else if(isUnusual&&type==='call')signal='UNUSUAL↑';
    else if(isUnusual&&type==='put') signal='UNUSUAL↓';
    else if(ratio>0.15) signal='ACTIVE';
    const isAlert=isLarge||isSweep||isUnusual;
    const row=document.createElement('div');
    row.className='ft-row'+(isAlert?' ft-alert':'')+(isAlert&&type==='call'?' ft-alert-call':isAlert&&type==='put'?' ft-alert-put':'');
    row.innerHTML=`
      <span class="${type}">${strike}</span>
      <span class="${type}">${type.toUpperCase()}</span>
      <span>${exp.slice(5)}</span>
      <span>${formatNum(oi)}</span>
      <span class="${vol>1000?(type==='call'?'green':'red'):''}">${formatNum(vol)}</span>
      <span>${iv?(iv*100).toFixed(0)+'%':'--'}</span>
      <span class="${isAlert?'sweep':''}">${signal}</span>`;
    body.appendChild(row);
  });
}

// ══════════════════════════════════════════════════════════
// LAYER 4 — STRUCTURE ENGINE
// ══════════════════════════════════════════════════════════
async function updateLayer4() {
  const price=STATE.price; if(!price) return;

  set('structPrice', price.toFixed(2));
  set('klCUR', price.toFixed(2));

  // Price change — honest label
  const prev=STATE.prevClose;
  let chgStr='--', chgClass='spb-change';
  if(prev&&prev>0){
    const diff=price-prev, pct=diff/prev*100;
    const src=STATE.marketOpen?'':' ∙ PREV CLOSE';
    chgStr=`${diff>=0?'+':''}${diff.toFixed(2)} | ${pct>=0?'+':''}${pct.toFixed(2)}%${src}`;
    chgClass+=(pct>=0?' pos':' neg');
  } else { chgStr='Price loaded (prev close unavailable)'; }
  set('structChange',chgStr);
  const scEl=$('structChange'); if(scEl)scEl.className=chgClass;

  // Sequential indicator fetches (throttled, no 429)
  const ema20r = await fetchEMA(STATE.ticker, 20);
  const ema50r = await fetchEMA(STATE.ticker, 50);
  const rsiR   = await fetchRSI(STATE.ticker);
  const macd   = await fetchMACD(STATE.ticker);

  // PrevDay from cache — no extra API call
  const pdRaw = STATE.cache['prev_'+STATE.ticker]?.data;
  const prevDay = pdRaw?.results?.[0]
    ? {open:pdRaw.results[0].o,high:pdRaw.results[0].h,low:pdRaw.results[0].l,close:pdRaw.results[0].c,vwap:pdRaw.results[0].vw}
    : null;

  const ema20=ema20r?.current??null, ema50=ema50r?.current??null;
  const rsi=rsiR?.current??null;
  STATE.indicators={ema20,ema50,rsi,macd,prevDay};

  // EMA 20
  if(ema20!=null){
    set('ema20',ema20.toFixed(2));
    const ab=price>ema20;
    const trend=ema20r.current>ema20r.prev?'▲':'▼';
    set('ema20rel',(ab?'ABOVE ':'BELOW ')+trend);
    const el=$('ema20rel'); if(el)el.className='ti-rel '+(ab?'bull':'bear');
  }

  // EMA 50
  if(ema50!=null){
    set('ema50',ema50.toFixed(2));
    const ab=price>ema50;
    const trend=ema50r.current>ema50r.prev?'▲':'▼';
    set('ema50rel',(ab?'ABOVE ':'BELOW ')+trend);
    const el=$('ema50rel'); if(el)el.className='ti-rel '+(ab?'bull':'bear');
  }

  // RSI with momentum arrow
  if(rsi!=null){
    set('rsi14',rsi.toFixed(1));
    const rsiPrev=rsiR.prev;
    const momentum=rsiPrev?(rsi>rsiPrev?'▲':'▼'):'';
    let sig=rsi>75?'OVERBOUGHT':rsi>60?'BULLISH':rsi>50?'MILD BULL':rsi<25?'OVERSOLD':rsi<40?'BEARISH':'MILD BEAR';
    set('rsiSignal',sig+' '+momentum);
    const el=$('rsiSignal'); if(el)el.className='ti-rel '+(rsi>50?'bull':'bear');
    const numEl=$('rsi14');
    if(numEl)numEl.style.color=rsi>70?'var(--orange)':rsi<30?'var(--cyan)':rsi>50?'var(--green)':'var(--red)';
  }

  // MACD — show HISTOGRAM (momentum), not the line value
  if(macd){
    const h=macd.histogram, prev=macd.prevHistogram;
    const histStr=(h>=0?'+':'')+h.toFixed(3);
    set('macdVal',histStr);  // histogram, not value
    const lineEl=$('macdLine'); if(lineEl)lineEl.textContent='Line: '+macd.value.toFixed(3);
    const growing=prev!=null?h>prev:null;
    let sig='';
    if(h>0)      sig=growing?'BULL ▲ GROWING':'BULL ▲ FADING';
    else         sig=growing===false?'BEAR ▼ GROWING':'BEAR ▼ FADING';
    set('macdSignal',sig);
    const el=$('macdSignal'); if(el)el.className='ti-rel '+(h>0?'bull':'bear');
    const numEl=$('macdVal');
    if(numEl)numEl.style.color=h>0?'var(--green)':'var(--red)';
  }

  // Price bias
  const abv20=ema20!=null&&price>ema20, abv50=ema50!=null&&price>ema50;
  let bias='NEUTRAL';
  if(abv20&&abv50)bias='BULLISH'; else if(!abv20&&!abv50)bias='BEARISH';
  else bias=abv20?'MILD BULL':'MILD BEAR';
  const bEl=$('structBias');
  if(bEl){bEl.textContent=bias;bEl.className='sb-val '+(bias.includes('BULL')?'bull':'bear');}
  STATE.regimeData.structureBullish=bias.includes('BULL');

  renderLevelStack(price, prevDay, ema20, ema50);
  updatePlaybookBanner();
}

function renderLevelStack(price, prevDay, ema20, ema50) {
  const stack=$('levelStack'); if(!stack)return;
  stack.innerHTML='';
  const od=STATE.regimeData.od;

  // All levels with tags — guaranteed order by price desc
  const levels=[];
  if(od?.callWall)   levels.push({name:'CALL WALL',    price:od.callWall,   type:'res',tag:'OI'});
  if(prevDay?.high)  levels.push({name:'PREV DAY HIGH',price:prevDay.high,   type:'res',tag:'PDH'});
  if(ema50!=null)    levels.push({name:'EMA 50',        price:ema50,          type:price>ema50?'sup':'res',tag:'EMA'});
  if(ema20!=null)    levels.push({name:'EMA 20',        price:ema20,          type:price>ema20?'sup':'res',tag:'EMA'});
  if(prevDay?.vwap)  levels.push({name:'PREV VWAP',     price:prevDay.vwap,   type:price>prevDay.vwap?'sup':'res',tag:'VWAP'});
  levels.push(                   {name:'▶ CURRENT',     price,                type:'cur',tag:''});
  if(od?.maxPain)    levels.push({name:'MAX PAIN γ',    price:od.maxPain,     type:'key',tag:'γ'});
  if(prevDay?.low)   levels.push({name:'PREV DAY LOW',  price:prevDay.low,    type:'sup',tag:'PDL'});
  if(od?.putWall)    levels.push({name:'PUT WALL',       price:od.putWall,     type:'sup',tag:'OI'});
  if(ema50!=null&&!levels.find(l=>l.price===ema50&&l.type!=='sup')){}

  levels.sort((a,b)=>b.price-a.price).forEach(l=>{
    const div=document.createElement('div');
    div.className='ls-level'+(l.type==='cur'?' current-level':'');
    const d=((l.price-price)/price*100);
    const distStr=l.type!=='cur'?`<span class="ls-dist ${d>=0?'green':'red'}">${d>=0?'+':''}${d.toFixed(2)}%</span>`:'';
    const badge=l.type==='key'?'key':l.type;
    div.innerHTML=`<span class="ls-badge ${badge}">${l.type==='cur'?'NOW':l.type==='res'?'RES':l.type==='key'?'KEY':'SUP'}</span><span class="ls-tag">${l.tag}</span><span class="ls-name">${l.name}</span><span class="ls-price">${l.price.toFixed(2)}</span>${distStr}`;
    stack.appendChild(div);
  });

  // Key levels table
  const od2=STATE.regimeData.od;
  set('klPWH', od2?.callWall ? od2.callWall.toFixed(0) : (prevDay?.high.toFixed(2)||'--'));
  set('klPWHs', od2?.callWall ? (price<od2.callWall?'▼ BELOW':'▲ ABOVE') : '--');
  set('klPDH', prevDay?.high.toFixed(2)||'--'); set('klPDHs',prevDay?.high?(price>prevDay.high?'▲ ABOVE':'▼ BELOW'):'--');
  set('klPDL', prevDay?.low.toFixed(2)||'--');  set('klPDLs',prevDay?.low?(price>prevDay.low?'▲ ABOVE':'▼ BELOW'):'--');
  set('klPWL', od2?.putWall ? od2.putWall.toFixed(0) : (prevDay?.low.toFixed(2)||'--'));
  set('klPWLs', od2?.putWall ? (price>od2.putWall?'▲ ABOVE':'▼ BELOW') : '--');
}

// ══════════════════════════════════════════════════════════
// LAYER 5 — PLAYBOOK ENGINE
// ══════════════════════════════════════════════════════════
function updateLayer5() {
  const rd=STATE.regimeData, od=rd.od, price=STATE.price;
  if(!price) return;

  // ── DIRECTIONALLY-AWARE CONFLUENCE SCORING ──────────────
  // Flow direction matters — bearish flow SUPPRESSES bull score
  let score=0;
  const factors=[];

  // Regime (20)
  if(rd.bullish){score+=20;factors.push('Regime bullish');}

  // Structure (20) — but reduce if flow contradicts
  if(rd.structureBullish){
    const structBonus=rd.flowBearish?8:20; // penalize if flow is bearish
    score+=structBonus;
    factors.push('Above EMAs'+(rd.flowBearish?' (flow conflict)':''));
  }

  // Flow (15) — bidirectional
  if(rd.flowBullish){score+=15;factors.push('Call flow dominant');}
  else if(rd.flowBearish){score-=5;} // bearish flow drags score down

  // Gamma (15)
  if(od&&!rd.gammaPositive){score+=15;factors.push('Neg gamma (expansion)');}
  else if(od&&rd.gammaPositive){score-=3;} // positive gamma = pin drag

  // Room to call wall (14)
  if(od?.callWall&&price<od.callWall){score+=14;factors.push('Room to call wall');}

  // Above max pain (8)
  if(od?.maxPain&&price>od.maxPain){score+=8;factors.push('Above max pain');}

  // VIX (7)
  if(rd.vix&&rd.vix<16){score+=7;factors.push('Low VIX');}
  else if(rd.vix&&rd.vix<20){score+=4;}

  // IV Skew penalty
  if(rd.bearishSkew){score-=5;factors.push('Bearish IV skew');}

  score=Math.min(100,Math.max(0,score));

  // ── SETUP CLASSIFICATION ─────────────────────────────────
  // FIX: FIRECRACKER is flow-direction aware
  // If flow is aggressive PUTS, this is a BEARISH firecracker = CASCADE risk
  const flowIsBull=rd.flowBullish, flowIsBear=rd.flowBearish;
  const flowIsAggressive=rd.flowSignal?.includes('AGGRESSIVE')||rd.flowSignal?.includes('STRONG');

  let setupName='MONITORING', setupDesc='Confluence below threshold. Await alignment.', playbookId=null;

  if(score>=80){
    setupName='TRIFECTA'; playbookId='pbc-trifecta';
    setupDesc=`Elite confluence ${score}%: all layers aligned. High-conviction expansion play.`;
  } else if(od&&!rd.gammaPositive&&rd.bullish&&score>=55){
    setupName='GAMMA EXPANSION'; playbookId='pbc-gamma';
    setupDesc='Neg gamma + bullish regime. Dealers hedging directionally — trend acceleration.';
  } else if(od?.callWall&&price>(od.maxPain||0)&&score>=45&&flowIsBull){
    setupName='MAGNET RUN'; playbookId='pbc-magnet';
    const path=od.staircase?.slice(0,3).map(s=>s.strike).join('→')||'--';
    setupDesc=`Above max pain $${od.maxPain?.toFixed(0)}. Call wall $${od.callWall?.toFixed(0)} magnet. Path: ${path}`;
  } else if(rd.gammaPositive&&od&&Math.abs(price-(od.maxPain||price))/price<0.015){
    setupName='PIN RISK'; playbookId='pbc-pin';
    setupDesc=`Pos gamma + price within 1.5% of max pain $${od.maxPain?.toFixed(0)}. Dealers pinning. Avoid expansion.`;
  } else if(flowIsAggressive&&flowIsBull&&score>=30){
    // Bullish aggressive flow = FIRECRACKER
    setupName='FIRECRACKER'; playbookId='pbc-firecracker';
    setupDesc=`${rd.flowSignal} — aggressive call flow. Cheap expansion if price structure confirms. Score: ${score}%.`;
  } else if(flowIsAggressive&&flowIsBear||score<25){
    // Bearish aggressive flow = CASCADE
    setupName='CASCADE'; playbookId='pbc-cascade';
    setupDesc=`${rd.flowSignal||'Bearish regime'} — put-heavy flow, breakdown risk. Dealer cascade possible.`;
  } else if(flowIsAggressive&&!flowIsBull&&!flowIsBear){
    setupName='FIRECRACKER'; playbookId='pbc-firecracker';
    setupDesc=`Unusual flow activity. Score: ${score}%. Confirm direction before acting.`;
  }

  set('asName',setupName); set('asDesc',setupDesc); set('pbPlay',setupName);
  const fill=$('ascFill'); if(fill)fill.style.width=score+'%';
  set('ascPct',score+'%');
  const pctEl=$('ascPct');
  if(pctEl)pctEl.style.color=score>=70?'var(--green)':score>=45?'var(--yellow)':'var(--red)';

  // Cards
  ['firecracker','trifecta','magnet','pin','gamma','cascade'].forEach(id=>{
    const card=$(`pbc-${id}`), status=$(`pbs-${id}`);
    if(!card||!status)return;
    const isActive=`pbc-${id}`===playbookId;
    card.className='pb-card'+(isActive?' active':' inactive');
    status.textContent=isActive?'● ACTIVE':'--';
    status.className='pbc-status'+(isActive?' active-s':' inactive-s');
  });

  // Probability map — directional
  const bullP=Math.min(Math.max(score,8),92), bearP=100-bullP;
  const bFill=$('pmBullFill'), rFill=$('pmBearFill');
  if(bFill)bFill.style.width=bullP+'%'; if(rFill)rFill.style.width=bearP+'%';
  set('pmBullPct',bullP+'%'); set('pmBearPct',bearP+'%');

  if(od?.staircase?.length>=2){
    const s=od.staircase;
    const path=[price.toFixed(0),...s.slice(0,3).map(x=>x.strike),od.callWall].filter(Boolean);
    set('pmBullPath',path.join(' → '));
  }
  if(od?.maxPain&&od?.putWall) set('pmBearPath',`${price.toFixed(0)} → ${od.maxPain?.toFixed(0)} → ${od.putWall?.toFixed(0)}`);

  const ind=STATE.indicators;
  set('pmBullCond',[od?.maxPain?`Hold $${od.maxPain?.toFixed(0)}`:'','SPY stable',rd.vix?`VIX < ${(rd.vix+4).toFixed(0)}`:''].filter(Boolean).join(' · '));
  set('pmBearCond',[ind.ema20?`EMA20 $${ind.ema20.toFixed(2)} fails`:'','Volume surge puts'].filter(Boolean).join(' · '));

  logSignal(`${setupName} | ${score}% | ${factors.slice(0,3).join(', ')}`, score>=60?'bull':score>=35?'':'bear');
}

// ── PLAYBOOK BANNER ───────────────────────────────────────
function updatePlaybookBanner() {
  const rd=STATE.regimeData, od=rd.od;
  set('pbRegime',rd.regime||'--');
  const bEl=$('pbBias');
  if(bEl){ bEl.textContent=rd.bullish===true?'BULLISH':rd.bullish===false?'BEARISH':'--'; bEl.className='pb-val '+(rd.bullish?'green':rd.bullish===false?'red':''); }
  set('pbGamma',rd.gammaPositive!=null?(rd.gammaPositive?'POS (PIN)':'NEG (EXP)'):'--');
  set('pbTarget',od?.callWall?'$'+od.callWall.toFixed(0):'--');
  set('pbRisk',rd.vix?(rd.vix>28?'HIGH':rd.vix>20?'ELEVATED':rd.vix>14?'NORMAL':'LOW'):'--');
  const riskEl=$('pbRisk');
  if(riskEl)riskEl.className='pb-val'+(rd.vix>25?' red':rd.vix>18?' yellow':rd.vix<14?' green':'');
}

// ── SIGNAL LOG ────────────────────────────────────────────
function logSignal(msg, type='') {
  const log=$('alertLog'); if(!log)return;
  const et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const time=`${String(et.getHours()).padStart(2,'0')}:${String(et.getMinutes()).padStart(2,'0')}`;
  const entry=document.createElement('div');
  entry.className='al-entry '+type;
  entry.innerHTML=`<span class="al-time">${time}</span><span>${msg}</span>`;
  log.insertBefore(entry,log.firstChild);
  while(log.children.length>60)log.removeChild(log.lastChild);
}

// ── FORMAT ────────────────────────────────────────────────
function formatNum(n){
  if(n==null||isNaN(n))return'--';
  if(n>=1e6)return(n/1e6).toFixed(2)+'M';
  if(n>=1e3)return(n/1e3).toFixed(1)+'K';
  return String(n);
}
function setLayerLoading(layer,on){
  const btn=document.querySelector(`[data-layer="${layer}"]`);
  if(btn)btn.className='panel-refresh'+(on?' spinning':'');
}

// ── FULL REFRESH ──────────────────────────────────────────
async function fullRefresh() {
  if(!STATE.apiKey){logSignal('Enter API key to begin','warn');return;}
  if(STATE.isRefreshing){logSignal('Refresh in progress…','');return;}
  STATE.isRefreshing=true;
  logSignal(`Scanning ${STATE.ticker}…`);
  set('regimeLabel','SCANNING…');
  [1,2,3,4,5].forEach(l=>setLayerLoading(l,true));
  try {
    await updateLayer1(); setLayerLoading(1,false);
    await updateLayer2(); setLayerLoading(2,false);
    await updateLayer3(); setLayerLoading(3,false);
    await updateLayer4(); setLayerLoading(4,false);
    updateLayer5();       setLayerLoading(5,false);
    const now=new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false});
    set('lastUpdate','Updated: '+now+' ET');
    if(STATE.marketOpen&&!STATE.wsConnected)connectWebSocket();
  } catch(e){
    logSignal('Refresh error: '+e.message,'warn');
    [1,2,3,4,5].forEach(l=>setLayerLoading(l,false));
  } finally { STATE.isRefreshing=false; }
}

// ── AUTO REFRESH ──────────────────────────────────────────
function startAutoRefresh(){
  if(STATE.refreshTimer)clearInterval(STATE.refreshTimer);
  if(STATE.cdTimer)clearInterval(STATE.cdTimer);
  STATE.countdown=CFG.REFRESH_INTERVAL;
  STATE.cdTimer=setInterval(()=>{
    STATE.countdown=Math.max(0,STATE.countdown-1);
    set('refreshCountdown',STATE.countdown);
    const el=$('refreshCountdown');
    if(el)el.style.color=STATE.countdown<=10?'var(--yellow)':'';
  },1000);
  STATE.refreshTimer=setInterval(()=>{fullRefresh();STATE.countdown=CFG.REFRESH_INTERVAL;},CFG.REFRESH_INTERVAL*1000);
}

// ── LAYER REFRESH BUTTONS ─────────────────────────────────
function attachRefreshButtons(){
  document.querySelectorAll('.panel-refresh').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      if(STATE.isRefreshing)return;
      const layer=parseInt(btn.dataset.layer);
      setLayerLoading(layer,true);
      try{
        if(layer===1)await updateLayer1();
        if(layer===2){await updateLayer2();updateLayer5();}
        if(layer===3)await updateLayer3();
        if(layer===4)await updateLayer4();
        if(layer===5)updateLayer5();
      }finally{setLayerLoading(layer,false);}
    });
  });
}

// ── INIT ──────────────────────────────────────────────────
function init(){
  startClock(); attachRefreshButtons();
  const savedKey=localStorage.getItem('instmap_key');
  const savedTicker=localStorage.getItem('instmap_ticker');
  if(savedKey){$('apiKeyInput').value=savedKey;STATE.apiKey=savedKey;}
  if(savedTicker){$('tickerInput').value=savedTicker;STATE.ticker=savedTicker;}
  const iwmL=document.querySelector('#rc-iwm .rc-ticker');
  if(iwmL)iwmL.textContent=STATE.ticker;

  $('loadBtn').addEventListener('click',()=>{
    const key=$('apiKeyInput').value.trim(), ticker=$('tickerInput').value.trim().toUpperCase();
    if(!key||!ticker){logSignal('API key + ticker required','warn');return;}
    STATE.apiKey=key; STATE.ticker=ticker;
    STATE.price=null; STATE.prevClose=null;
    STATE.regimeData={}; STATE.cache={}; STATE.apiCallCount=0;
    localStorage.setItem('instmap_key',key); localStorage.setItem('instmap_ticker',ticker);
    const iwmT=document.querySelector('#rc-iwm .rc-ticker'); if(iwmT)iwmT.textContent=ticker;
    if(STATE.ws){try{STATE.ws.close();}catch(_){}STATE.ws=null;}
    fullRefresh(); startAutoRefresh();
  });
  $('apiKeyInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('loadBtn').click();});
  $('tickerInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('loadBtn').click();});
  set('refreshCountdown',CFG.REFRESH_INTERVAL);
  if(STATE.apiKey){fullRefresh();startAutoRefresh();}
}
document.addEventListener('DOMContentLoaded',init);

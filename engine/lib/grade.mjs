// Grading, closing-line value, performance summaries, and the threshold-learning loop.
import { CFG, project, evaluate, selectPicks } from './model.mjs';
import { lineProbs, noVig, implied, round } from './util.mjs';

export function outcome(bet, g) {
  if (!g) return null;
  if (g.canceled) return 'V';
  if (!g.completed || g.hs == null || g.as == null) return null;
  const m = g.hs - g.as, t = g.hs + g.as;
  let x;
  if (bet.market === 'spread') x = (bet.side === 'home' ? m : -m) + bet.line;
  else if (bet.market === 'ml') x = bet.side === 'home' ? m : -m;
  else x = bet.side === 'over' ? t - bet.line : bet.line - t;
  return x > 0 ? 'W' : x < 0 ? 'L' : 'P';
}

export const decOf = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

// Closing line value: did we get a better number than where the market closed?
export function clv(bet, g, sport) {
  const c = g?.close;
  if (!c) return {};
  const sd = CFG[sport].sd, sdT = CFG[sport].sdTot;
  if (bet.market === 'spread' && c.spread != null) {
    const closeLine = bet.side === 'home' ? c.spread : -c.spread;
    const muClose = -closeLine; // market's expected margin for our side
    const p = lineProbs(muClose, sd, bet.line);
    return { closeLine, clvPts: round(bet.line - closeLine, 1), clvProb: round(p.win + p.push / 2 - 0.5, 4) };
  }
  if (bet.market === 'total' && c.total != null) {
    const pts = bet.side === 'over' ? c.total - bet.line : bet.line - c.total;
    const mu = bet.side === 'over' ? c.total : -c.total;
    const p = lineProbs(mu, sdT, bet.side === 'over' ? -bet.line : bet.line);
    return { closeLine: c.total, clvPts: round(pts, 1), clvProb: round(p.win + p.push / 2 - 0.5, 4) };
  }
  if (bet.market === 'ml' && c.mlHome != null && c.mlAway != null) {
    const [ph, pa] = noVig(c.mlHome, c.mlAway);
    const closeP = bet.side === 'home' ? ph : pa;
    const pickP = bet.oppPrice != null ? noVig(bet.price, bet.oppPrice)[0] : implied(bet.price);
    return { closePrice: bet.side === 'home' ? c.mlHome : c.mlAway, clvProb: round(closeP - pickP, 4) };
  }
  return {};
}

export function gradeLedger(ledger, gamesById) {
  let changed = 0;
  for (const p of ledger.picks) {
    if (p.status !== 'open') continue;
    const g = gamesById[p.sport]?.[p.gameId];
    const r = outcome(p, g);
    if (!r) continue;
    p.status = r;
    p.profit = r === 'W' ? round(p.units * (decOf(p.price) - 1), 3) : r === 'L' ? -p.units : 0;
    p.final = `${g.away.abbr} ${g.as} – ${g.home.abbr} ${g.hs}`;
    Object.assign(p, clv(p, g, p.sport));
    p.gradedAt = new Date().toISOString();
    changed++;
  }
  for (const t of ledger.parlays) {
    if (t.status !== 'open') continue;
    let done = true, lost = false, dec = 1;
    for (const l of t.legs) {
      const g = gamesById[t.sport]?.[l.gameId];
      if (!l.result) l.result = outcome(l, g);
      if (!l.result) { done = false; continue; }
      if (l.result === 'L') lost = true;
      if (l.result === 'W') dec *= decOf(l.price);
    }
    if (lost) done = true;
    if (!done) continue;
    t.status = lost ? 'L' : dec > 1 ? 'W' : 'P';
    t.profit = lost ? -t.units : round(t.units * (dec - 1), 3);
    t.legsHit = t.legs.filter(l => l.result === 'W').length;
    t.gradedAt = new Date().toISOString();
    changed++;
  }
  return changed;
}

export function summarize(list) {
  const g = list.filter(p => ['W', 'L', 'P'].includes(p.status));
  const s = { n: g.length, w: 0, l: 0, p: 0, units: 0, staked: 0, open: list.filter(p => p.status === 'open').length };
  let clvSum = 0, clvN = 0, beat = 0, evSum = 0;
  for (const p of g) {
    s[p.status.toLowerCase()]++;
    s.units += p.profit || 0;
    s.staked += p.units || 0;
    evSum += p.ev || 0;
    if (p.clvProb != null) { clvSum += p.clvProb; clvN++; if (p.clvProb > 0.0005) beat++; }
  }
  s.units = round(s.units, 2);
  s.staked = round(s.staked, 2);
  s.roi = s.staked ? round(s.units / s.staked, 4) : null;
  s.hit = s.w + s.l ? round(s.w / (s.w + s.l), 4) : null;
  s.avgEv = s.n ? round(evSum / s.n, 4) : null;
  s.avgClv = clvN ? round(clvSum / clvN, 4) : null;
  s.beatClose = clvN ? round(beat / clvN, 4) : null;
  return s;
}

const group = (list, key) => {
  const out = {};
  for (const p of list) { const k = key(p); (out[k] ||= []).push(p); }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, summarize(v)]));
};

export function calibration(points) {
  // points: [{p, hit}] ; buckets of predicted win probability
  const edges = [0.45, 0.5, 0.53, 0.56, 0.6, 0.65, 0.7, 0.8, 1.01];
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const b = points.filter(x => x.p >= edges[i] && x.p < edges[i + 1]);
    if (!b.length) continue;
    out.push({ lo: edges[i], hi: Math.min(1, edges[i + 1]), n: b.length, pred: round(b.reduce((s, x) => s + x.p, 0) / b.length, 4), actual: round(b.filter(x => x.hit).length / b.length, 4) });
  }
  return out;
}

export function liveStats(ledger) {
  const picks = ledger.picks;
  const graded = picks.filter(p => ['W', 'L', 'P'].includes(p.status)).sort((a, b) => a.date.localeCompare(b.date) || (a.kickoff || '').localeCompare(b.kickoff || ''));
  const parlays = ledger.parlays;
  const series = [];
  let run = 0;
  const all = [...graded.map(p => ({ date: p.date, profit: p.profit })), ...parlays.filter(t => t.status !== 'open').map(t => ({ date: t.date, profit: t.profit }))].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map();
  for (const x of all) byDate.set(x.date, (byDate.get(x.date) || 0) + x.profit);
  for (const [date, prof] of byDate) { run += prof; series.push({ date, units: round(run, 2) }); }
  const pt = t => ({ ...t, status: t.status, units: t.units, profit: t.profit });
  return {
    overall: summarize(picks),
    bySport: group(picks, p => p.sport),
    byTier: group(picks, p => p.tier),
    byMarket: group(picks, p => p.market),
    bySide: group(picks, p => (p.market === 'total' ? p.side : (p.price < 0 && p.market === 'ml') || (p.market === 'spread' && p.line < 0) ? 'favorite' : 'underdog')),
    parlays: { crown: summarize(parlays.filter(t => t.type === 'crown-parlay').map(pt)), hail: summarize(parlays.filter(t => t.type === 'hail-mary').map(pt)), legs: (() => { const legs = parlays.flatMap(t => t.legs).filter(l => l.result && l.result !== 'V'); return { hit: legs.filter(l => l.result === 'W').length, n: legs.filter(l => l.result !== 'P').length }; })() },
    series,
    calibration: calibration(graded.filter(p => p.status !== 'P').map(p => ({ p: p.win, hit: p.status === 'W' }))),
  };
}

// Simulate the pick rules over the walk-forward backtest at closing prices.
export function simulateBacktest(rows, sport, params, thresholds) {
  const byWeek = new Map();
  const calPts = [];
  let atsN = 0, atsW = 0;
  for (const r of rows) {
    const proj = project(r.c, r.g.close, sport, params, r.move);
    if (proj.mu == null) continue;
    const pr = lineProbs(proj.mu, CFG[sport].sd, r.g.close.spread);
    const pHome = pr.win + pr.push / 2;
    const homeCover = r.margin + r.g.close.spread;
    if (homeCover !== 0) calPts.push(pHome >= 0.5 ? { p: pHome, hit: homeCover > 0 } : { p: 1 - pHome, hit: homeCover < 0 });
    if (Math.abs(proj.muModel - proj.muMkt) >= 2 && homeCover !== 0) { atsN++; if ((proj.muModel > proj.muMkt) === (homeCover > 0)) atsW++; }
    const k = `${r.g.seasonType}-${r.g.week}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push({ g: r.g, comp: r.c, proj, cands: evaluate(r.g, proj, r.g.close, sport) });
  }
  const bets = [];
  for (const entries of byWeek.values()) {
    for (const e of selectPicks(entries, sport, thresholds)) {
      const p = e.pick;
      const res = outcome(p, e.g);
      bets.push({ ...p, status: res, profit: res === 'W' ? p.units * (decOf(p.price) - 1) : res === 'L' ? -p.units : 0, sport });
    }
  }
  return {
    games: rows.length,
    picks: summarize(bets),
    byMarket: group(bets, p => p.market),
    byTier: group(bets, p => p.tier),
    modelAts: { n: atsN, w: atsW, hit: atsN ? round(atsW / atsN, 4) : null },
    calibration: calibration(calPts),
  };
}

// Learning loop: if a market keeps losing *and* keeps losing to the closing line, demand more edge.
export function learnThresholds(ledger, sport, model) {
  const base = CFG[sport].minEV;
  const th = { ...base, ...(model.thresholds?.[sport] || {}) };
  const log = [];
  for (const mk of Object.keys(base)) {
    const s = summarize(ledger.picks.filter(p => p.sport === sport && p.market === mk));
    let next = base[mk];
    if (s.n >= 25 && s.roi < -0.08 && (s.avgClv ?? 0) < 0) next = base[mk] + 0.015;
    if (s.n >= 50 && s.roi < -0.08 && (s.avgClv ?? 0) < 0) next = base[mk] + 0.03;
    next = round(next, 4);
    if (next !== round(th[mk], 4)) {
      log.push(`${CFG[sport].label} ${mk}: min edge ${(th[mk] * 100).toFixed(1)}% → ${(next * 100).toFixed(1)}% (${s.n} graded, ROI ${(s.roi * 100).toFixed(1)}%, avg CLV ${((s.avgClv ?? 0) * 100).toFixed(1)}%)`);
      th[mk] = next;
    }
  }
  return { thresholds: th, log };
}

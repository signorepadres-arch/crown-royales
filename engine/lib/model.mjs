// The Crown Royales model.
//  1. Results ratings: ridge regression on (capped, recency-weighted) game margins and totals.
//  2. Market ratings:  the same regression fit to past closing lines (what the market thinks of each team).
//  3. Model line = a·results + (1-a)·market-ratings.
//  4. Blended line = w·model + (1-w)·current market line   (w is learned from the season's walk-forward backtest).
//  5. Every bet is priced off the blended line with a normal margin distribution; only +EV bets qualify.
import { fitMargin, fitTotals } from './ratings.mjs';
import { lineProbs, toDec, noVig, Phi, PhiInv, clamp, round, fmtLine, fmtAmerican, decToAmerican } from './util.mjs';

export const CFG = {
  nfl: {
    label: 'NFL', sd: 13.5, sdTot: 13.0, lambdaRes: 5, lambdaMkt: 0.3, lambdaTot: 6, lambdaTotMkt: 0.4,
    hfa: 1.8, halfLife: 8, cap: 28, minGP: 3, maxDisagree: 7, maxTotDisagree: 7, maxSpread: 14, maxEV: 0.12,
    minEV: { spread: 0.025, ml: 0.03, total: 0.03 }, maxPicks: 6, mlRange: [-300, 300],
    defaults: { a: 0.5, w: 0.3, at: 0.5, wt: 0.25 },
  },
  cfb: {
    label: 'CFB', sd: 16.0, sdTot: 16.5, lambdaRes: 1.5, lambdaMkt: 0.2, lambdaTot: 2, lambdaTotMkt: 0.3,
    hfa: 2.8, halfLife: 6, cap: 35, minGP: 3, maxDisagree: 10, maxTotDisagree: 10, maxSpread: 24, maxEV: 0.12,
    minEV: { spread: 0.03, ml: 0.035, total: 0.035 }, maxPicks: 8, mlRange: [-300, 300],
    defaults: { a: 0.5, w: 0.3, at: 0.5, wt: 0.25 },
  },
};
export const TIERS = { royal: { ev: 0.06, minWin: 0.5 }, crown: { ev: 0.04 } };
export const W_FLOOR = 0.15, W_CEIL = 0.5;

const DAY = 864e5;
const capMargin = (m, cap) => Math.sign(m) * cap * Math.tanh(Math.abs(m) / cap);

export function buildModel(games, sport, asOf) {
  const cfg = CFG[sport];
  const res = [], mkt = [], tot = [], totMkt = [], gp = {}, prior = {};
  for (const g of games) {
    const t = Date.parse(g.date);
    if (!(t < asOf) || g.canceled) continue;
    const w = Math.pow(0.5, (asOf - t) / DAY / 7 / cfg.halfLife);
    const h = g.home.id, a = g.away.id;
    if (sport === 'cfb') {
      if (g.home.fbs === false) prior[h] = -18;
      if (g.away.fbs === false) prior[a] = -18;
    }
    if (g.completed && g.hs != null && g.as != null) {
      res.push({ h, a, neutral: g.neutral, y: capMargin(g.hs - g.as, cfg.cap), w });
      tot.push({ h, a, y: g.hs + g.as, w });
      gp[h] = (gp[h] || 0) + 1; gp[a] = (gp[a] || 0) + 1;
    }
    const c = g.close;
    if (c && c.spread != null) mkt.push({ h, a, neutral: g.neutral, y: -c.spread, w });
    if (c && c.total != null) totMkt.push({ h, a, y: c.total, w });
  }
  return {
    gp,
    res: fitMargin(res, { lambda: cfg.lambdaRes, hfaPrior: cfg.hfa, prior }),
    mkt: mkt.length >= 8 ? fitMargin(mkt, { lambda: cfg.lambdaMkt, hfaPrior: cfg.hfa, prior }) : null,
    tot: tot.length >= 8 ? fitTotals(tot, { lambda: cfg.lambdaTot }) : null,
    totMkt: totMkt.length >= 8 ? fitTotals(totMkt, { lambda: cfg.lambdaTotMkt }) : null,
  };
}

// Raw components for one game (before the a/w blends).
export function components(g, M, sport) {
  const cfg = CFG[sport];
  const h = g.home.id, a = g.away.id, hv = g.neutral ? 0 : 1;
  const out = { gpH: M.gp[h] || 0, gpA: M.gp[a] || 0 };
  out.muRes = (M.res.r[h] ?? 0) - (M.res.r[a] ?? 0) + hv * M.res.hfa;
  if (M.mkt && M.mkt.r[h] != null && M.mkt.r[a] != null) out.muMr = M.mkt.r[h] - M.mkt.r[a] + hv * M.mkt.hfa;
  if (M.tot) out.totRes = 2 * M.tot.m + (M.tot.k[h] ?? 0) + (M.tot.k[a] ?? 0);
  if (M.totMkt && M.totMkt.k[h] != null && M.totMkt.k[a] != null) out.totMr = 2 * M.totMkt.m + M.totMkt.k[h] + M.totMkt.k[a];
  out.qualified = out.gpH >= cfg.minGP && out.gpA >= cfg.minGP;
  return out;
}
// Line movement since open, in home-margin points (positive = market moved toward the home team).
export function lineMove(g, odds) {
  const open = g.open?.spread, cur = odds?.spread;
  return open != null && cur != null ? open - cur : 0;
}

export function marketMu(odds, sport) {
  if (!odds) return null;
  if (odds.spread != null) return -odds.spread;
  if (odds.mlHome != null && odds.mlAway != null) return CFG[sport].sd * PhiInv(noVig(odds.mlHome, odds.mlAway)[0]);
  return null;
}

export function project(comp, odds, sport, P, move = 0) {
  const muModel = comp.muMr != null ? P.a * comp.muRes + (1 - P.a) * comp.muMr : comp.muRes;
  let totModel = null;
  if (comp.totRes != null && comp.totMr != null) totModel = P.at * comp.totRes + (1 - P.at) * comp.totMr;
  else totModel = comp.totMr ?? comp.totRes ?? null;
  const muMkt = marketMu(odds, sport);
  const totMkt = odds?.total ?? null;
  return {
    muModel, totModel, muMkt, totMkt,
    move,
    mu: muMkt == null ? null : P.w * muModel + (1 - P.w) * muMkt + (P.k || 0) * move,
    tot: totMkt == null || totModel == null ? null : P.wt * totModel + (1 - P.wt) * totMkt,
  };
}

function priced(market, side, line, price, pr) {
  const b = toDec(price) - 1;
  const ev = pr.win * b - pr.loss;
  const kelly = Math.max(0, (pr.win * b - pr.loss) / b);
  return { market, side, line, price, win: pr.win, push: pr.push, loss: pr.loss, ev, kelly };
}

export function evaluate(g, proj, odds, sport) {
  const cfg = CFG[sport];
  const out = [];
  if (!odds || proj.mu == null) return out;
  const H = g.home.abbr, A = g.away.abbr;
  if (odds.spread != null) {
    out.push({ ...priced('spread', 'home', odds.spread, odds.spreadHomePrice ?? -110, lineProbs(proj.mu, cfg.sd, odds.spread)), label: `${H} ${fmtLine(odds.spread)}` });
    out.push({ ...priced('spread', 'away', -odds.spread, odds.spreadAwayPrice ?? -110, lineProbs(-proj.mu, cfg.sd, -odds.spread)), label: `${A} ${fmtLine(-odds.spread)}` });
  }
  if (odds.mlHome != null && odds.mlAway != null) {
    // Anchor on the market's own moneyline (its spread→ML mapping is sharper than a plain normal),
    // then shift by how far the blended line sits from the market line.
    const pMkt = noVig(odds.mlHome, odds.mlAway)[0];
    const pw = clamp(Phi(PhiInv(pMkt) + (proj.mu - proj.muMkt) / cfg.sd), 0.01, 0.99);
    for (const [side, price, p, ab] of [['home', odds.mlHome, pw, H], ['away', odds.mlAway, 1 - pw, A]]) {
      if (price < cfg.mlRange[0] || price > cfg.mlRange[1]) continue;
      out.push({ ...priced('ml', side, 0, price, { win: p, push: 0, loss: 1 - p }), label: `${ab} ML` });
    }
  }
  if (odds.total != null && proj.tot != null) {
    out.push({ ...priced('total', 'over', odds.total, odds.overPrice ?? -110, lineProbs(proj.tot, cfg.sdTot, -odds.total)), label: `Over ${odds.total}` });
    out.push({ ...priced('total', 'under', odds.total, odds.underPrice ?? -110, lineProbs(-proj.tot, cfg.sdTot, odds.total)), label: `Under ${odds.total}` });
  }
  return out;
}

export function unitsFor(c, tier) {
  let u = Math.round(clamp(0.25 * c.kelly * 100, 0.5, 3) * 2) / 2;
  if (tier === 'royal') u = Math.max(u, 2);
  return u;
}

// Pick the best qualifying bet per game, then tier and cap the card.
export function selectPicks(entries, sport, thresholds) {
  const cfg = CFG[sport];
  const best = [];
  for (const e of entries) {
    const { comp, proj, cands } = e;
    if (!comp.qualified || proj.mu == null) continue;
    const sideOk = c => {
      if (c.market === 'total') return proj.totModel != null && Math.abs(proj.totModel - proj.totMkt) <= cfg.maxTotDisagree;
      return Math.abs(proj.muModel - proj.muMkt) <= cfg.maxDisagree;
    };
    // Guardrails: skip giant spreads (garbage-time noise) and "too good to be true" edges (usually stale data / injury news).
    const sane = c => c.ev <= cfg.maxEV && (c.market !== 'spread' || Math.abs(c.line) <= cfg.maxSpread) && (c.market !== 'ml' || Math.abs(proj.muMkt) <= cfg.maxSpread);
    const ok = cands.filter(c => c.ev >= (thresholds[c.market] ?? cfg.minEV[c.market]) && sideOk(c) && sane(c));
    if (!ok.length) continue;
    ok.sort((x, y) => y.ev - x.ev);
    best.push({ ...e, pick: ok[0] });
  }
  best.sort((x, y) => y.pick.ev - x.pick.ev);
  const card = best.slice(0, cfg.maxPicks);
  card.forEach((e, i) => {
    const p = e.pick;
    p.tier = (i === 0 && p.ev >= TIERS.royal.ev && p.win >= TIERS.royal.minWin) ? 'royal' : p.ev >= TIERS.crown.ev ? 'crown' : 'lean';
    p.units = unitsFor(p, p.tier);
  });
  return card;
}

// Parlays: a short "Crown Parlay" of high-probability +EV legs, and a long-shot "Hail Mary".
export function buildParlays(entries) {
  const legs = [];
  for (const e of entries) {
    if (!e.comp.qualified) continue;
    const pos = e.cands.filter(c => c.ev > 0 && c.push < 0.02).sort((x, y) => y.ev - x.ev)[0];
    if (pos) legs.push({ e, c: pos });
  }
  const make = (chosen, type, units) => {
    if (chosen.length < 2) return null;
    const dec = chosen.reduce((s, l) => s * toDec(l.c.price), 1);
    const prob = chosen.reduce((s, l) => s * l.c.win, 1);
    return {
      type, units, dec: round(dec, 3), price: decToAmerican(dec), prob: round(prob, 4), ev: round(prob * dec - 1, 4),
      legs: chosen.map(l => ({ gameId: l.e.g.id, market: l.c.market, side: l.c.side, line: l.c.line, price: l.c.price, label: l.c.label, win: round(l.c.win, 4), matchup: `${l.e.g.away.abbr} @ ${l.e.g.home.abbr}` })),
    };
  };
  const safe = legs.filter(l => l.c.win >= 0.56).sort((x, y) => y.c.win * (1 + y.c.ev) - x.c.win * (1 + x.c.ev)).slice(0, 3);
  const crown = make(safe, 'crown-parlay', 1);
  const hm = [];
  let dec = 1;
  for (const l of [...legs].sort((x, y) => y.c.ev - x.c.ev)) {
    if (hm.length >= 7 || dec >= 31) break;
    hm.push(l); dec *= toDec(l.c.price);
  }
  const hail = hm.length >= 4 ? make(hm, 'hail-mary', 0.5) : null;
  return [crown, hail].filter(p => p && p.ev > 0);
}

// ---------- walk-forward backtest + parameter learning ----------
export function backtestRows(games, sport) {
  const byWeek = new Map();
  for (const g of games) {
    if (!g.completed || g.canceled || g.hs == null || !g.close || g.close.spread == null) continue;
    const k = `${g.seasonType}-${g.week}`;
    if (!byWeek.has(k)) byWeek.set(k, []);
    byWeek.get(k).push(g);
  }
  const rows = [];
  for (const wk of byWeek.values()) {
    const asOf = Math.min(...wk.map(g => Date.parse(g.date))) - 6 * 3600e3;
    const M = buildModel(games, sport, asOf);
    for (const g of wk) {
      const c = components(g, M, sport);
      if (!c.qualified) continue;
      rows.push({ g, c, muMkt: -g.close.spread, move: lineMove(g, g.close), totMkt: g.close.total ?? null, margin: g.hs - g.as, total: g.hs + g.as });
    }
  }
  return rows;
}

export function tune(rows, sport, prev) {
  const D = CFG[sport].defaults;
  const n = rows.length;
  const mse = f => rows.reduce((s, r) => s + (r.margin - f(r)) ** 2, 0) / n;
  const out = { n, a: prev?.a ?? D.a, w: prev?.w ?? D.w, at: prev?.at ?? D.at, wt: prev?.wt ?? D.wt, k: prev?.k ?? 0 };
  if (n < 40) return { ...out, note: 'Not enough completed games with closing lines yet — using defaults.' };
  let best = { e: Infinity };
  for (let a = 0; a <= 1.0001; a += 0.25) for (let w = 0; w <= W_CEIL + 1e-9; w += 0.05) {
    const e = mse(r => { const mm = r.c.muMr != null ? a * r.c.muRes + (1 - a) * r.c.muMr : r.c.muRes; return w * mm + (1 - w) * r.muMkt; });
    if (e < best.e) best = { e, a, w };
  }
  const shrink = n / (n + 150);
  out.a = round(D.a + (best.a - D.a) * shrink, 3);
  out.w = round(clamp(D.w + (best.w - D.w) * shrink, W_FLOOR, W_CEIL), 3);
  out.mseMarket = round(mse(r => r.muMkt), 2);
  out.mseModel = round(mse(r => (r.c.muMr != null ? out.a * r.c.muRes + (1 - out.a) * r.c.muMr : r.c.muRes)), 2);
  const blend = r => out.w * (r.c.muMr != null ? out.a * r.c.muRes + (1 - out.a) * r.c.muMr : r.c.muRes) + (1 - out.w) * r.muMkt;
  out.mseBlend = round(mse(blend), 2);
  // line-movement weight k (follow/fade the steam), heavily shrunk toward 0
  const mv = rows.filter(r => r.move !== 0);
  if (mv.length >= 60) {
    let bk = { e: Infinity, k: 0 };
    for (let k = -0.6; k <= 0.6 + 1e-9; k += 0.05) {
      const e = mv.reduce((s, r) => s + (r.margin - blend(r) - k * r.move) ** 2, 0);
      if (e < bk.e) bk = { e, k };
    }
    out.k = round(clamp(bk.k * mv.length / (mv.length + 300), -0.4, 0.4), 3);
    out.nMove = mv.length;
    let n = 0, w = 0;
    for (const r of mv) { const cov = r.margin + r.g.close.spread; if (!cov) continue; n++; if ((r.move > 0) === (cov > 0)) w++; }
    out.steam = { n, w, hit: n ? round(w / n, 4) : null };
  } else out.k = 0;
  const tr = rows.filter(r => r.totMkt != null && (r.c.totRes != null || r.c.totMr != null));
  if (tr.length >= 40) {
    const tm = (r, at) => (r.c.totRes != null && r.c.totMr != null ? at * r.c.totRes + (1 - at) * r.c.totMr : (r.c.totMr ?? r.c.totRes));
    const tmse = f => tr.reduce((s, r) => s + (r.total - f(r)) ** 2, 0) / tr.length;
    let bt = { e: Infinity };
    for (let at = 0; at <= 1.0001; at += 0.25) for (let wt = 0; wt <= W_CEIL + 1e-9; wt += 0.05) {
      const e = tmse(r => wt * tm(r, at) + (1 - wt) * r.totMkt);
      if (e < bt.e) bt = { e, at, wt };
    }
    const s2 = tr.length / (tr.length + 150);
    out.at = round(D.at + (bt.at - D.at) * s2, 3);
    out.wt = round(clamp(D.wt + (bt.wt - D.wt) * s2, W_FLOOR, W_CEIL), 3);
    out.mseTotMarket = round(tmse(r => r.totMkt), 2);
    out.mseTotBlend = round(tmse(r => out.wt * tm(r, out.at) + (1 - out.wt) * r.totMkt), 2);
  }
  return out;
}

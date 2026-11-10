#!/usr/bin/env node
// Crown Royales engine — one run:
//   fetch ESPN → save lines → backfill closing lines → learn params (walk-forward backtest)
//   → project the upcoming slate → publish the card at release time → grade → write data/*.json
import { LEAGUES, scoreboard, parseEvent, coreOdds, parseOdds, stats as fetchStats } from './lib/espn.mjs';
import { CFG, buildModel, components, project, evaluate, selectPicks, buildParlays, backtestRows, tune } from './lib/model.mjs';
import { gradeLedger, liveStats, simulateBacktest, learnThresholds, summarize } from './lib/grade.mjs';
import { readJSON, writeJSON, etParts, etToDate, addDaysYMD, seasonYear, round } from './lib/util.mjs';

const VERSION = '2.0.0';
const NOW = process.env.CR_NOW ? new Date(process.env.CR_NOW) : new Date();
const nowMs = NOW.getTime();
const RELEASE_HOUR_ET = 10; // official card locks at 10:00 AM ET on slate day
const SLATE_DOW = { nfl: 0, cfb: 6 }; // Sunday NFL, Saturday CFB
const SLATE_LABEL = { nfl: 'Sunday NFL', cfb: 'Saturday College Football' };
const errors = [];
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function slateDay(sport) {
  const { ymd, dow } = etParts(NOW);
  return addDaysYMD(ymd, (SLATE_DOW[sport] - dow + 7) % 7);
}

function merge(store, e) {
  if (!e) return;
  const prev = store.games[e.id] || {};
  const { odds, ...rest } = e;
  const g = { ...prev, ...rest };
  if (e.state === 'pre' && odds) {
    g.close = odds; // latest pre-kickoff line; becomes the closing line once the game starts
    g.closeAt = NOW.toISOString();
    g.closeSource = 'scoreboard';
    if (!g.open) g.open = { spread: odds.open?.spread ?? odds.spread, total: odds.open?.total ?? odds.total, mlHome: odds.open?.mlHome ?? odds.mlHome, mlAway: odds.open?.mlAway ?? odds.mlAway };
  }
  store.games[e.id] = g;
}

async function refresh(sport, store) {
  const season = seasonYear(NOW);
  if (store.season !== season) { store.season = season; store.games = {}; }
  const def = await scoreboard(sport);
  const cur = def?.week?.number ?? 1;
  const type = def?.season?.type ?? 2;
  const weeksHave = new Set(Object.values(store.games).filter(g => g.seasonType === 2).map(g => g.week));
  const firstRun = type === 2 ? weeksHave.size < Math.min(cur, LEAGUES[sport].regWeeks) - 1 : weeksHave.size < 8;
  (def?.events || []).forEach(ev => merge(store, parseEvent(ev)));
  const plan = [];
  if (type === 2) {
    const from = firstRun ? 1 : Math.max(1, cur - 1);
    for (let w = from; w <= Math.min(cur + 1, LEAGUES[sport].regWeeks); w++) plan.push([w, 2]);
  } else if (type === 3) {
    if (firstRun) for (let w = 1; w <= LEAGUES[sport].regWeeks; w++) plan.push([w, 2]);
    for (let w = 1; w <= cur + 1; w++) plan.push([w, 3]);
  }
  // re-fetch any older week that still has unfinished games
  const stale = new Set();
  for (const g of Object.values(store.games)) {
    if (!g.completed && !g.canceled && Date.parse(g.date) < nowMs - 5 * 3600e3 && g.week != null) stale.add(`${g.week}|${g.seasonType}`);
  }
  for (const s of stale) { const [w, t] = s.split('|').map(Number); if (!plan.some(([a, b]) => a === w && b === t)) plan.push([w, t]); }
  for (const [week, seasontype] of plan) {
    const sb = await scoreboard(sport, { week, seasontype, season });
    (sb?.events || []).forEach(ev => merge(store, parseEvent(ev)));
  }
  log(`${sport}: week ${cur} (type ${type}), fetched ${plan.length} weeks, ${Object.keys(store.games).length} games stored`);
}

// Pull the true closing line from ESPN's core odds feed for games that have kicked off.
async function backfill(sport, store, limit = 700) {
  const todo = Object.values(store.games).filter(g => g.state !== 'pre' && !g.canceled && !g.coreTried && g.closeSource !== 'core').slice(0, limit);
  let got = 0;
  const work = todo.slice();
  async function worker() {
    while (work.length) {
      const g = work.pop();
      try {
        const o = parseOdds(await coreOdds(sport, g.id), g.home.abbr, g.away.abbr);
        if (o && (o.spread != null || o.total != null)) {
          if (g.close) g.lastSeen = { spread: g.close.spread, total: g.close.total, mlHome: g.close.mlHome, mlAway: g.close.mlAway, at: g.closeAt };
          g.close = { ...(g.close || {}), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) };
          g.closeSource = 'core';
          if (!g.open && o.open) g.open = o.open;
          got++;
        }
        if (g.completed) g.coreTried = true;
      } catch (e) { /* retry next run */ }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (todo.length) log(`${sport}: closing lines backfilled ${got}/${todo.length}`);
}

const teamOut = (t, score) => ({ id: t.id, abbr: t.abbr, name: t.name, logo: t.logo, rank: t.rank, record: t.record, score });

function pickRecord(sport, slateId, slateYmd, e, publishedAt) {
  const p = e.pick, g = e.g, o = g.close;
  const oppPrice = p.market === 'ml' ? (p.side === 'home' ? o.mlAway : o.mlHome)
    : p.market === 'spread' ? (p.side === 'home' ? o.spreadAwayPrice : o.spreadHomePrice)
    : (p.side === 'over' ? o.underPrice : o.overPrice);
  return {
    id: `${slateId}:${g.id}:${p.market}:${p.side}`, slateId, sport, date: slateYmd, gameId: g.id, kickoff: g.date,
    matchup: `${g.away.abbr} @ ${g.home.abbr}`, away: g.away.abbr, home: g.home.abbr,
    label: p.label, market: p.market, side: p.side, line: p.line, price: p.price, oppPrice,
    win: round(p.win, 4), push: round(p.push, 4), ev: round(p.ev, 4), tier: p.tier, units: p.units,
    modelLine: round(-e.proj.muModel, 1), fairLine: round(-e.proj.mu, 1), marketLine: round(-e.proj.muMkt, 1),
    modelTotal: round(e.proj.totModel, 1), fairTotal: round(e.proj.tot, 1), marketTotal: e.proj.totMkt,
    publishedAt, status: 'open', profit: null,
  };
}

async function main() {
  const t0 = Date.now();
  const ledger = readJSON('ledger.json', { version: 2, slates: {}, picks: [], parlays: [] });
  const model = readJSON('model.json', { params: {}, thresholds: {}, log: [] });
  const board = { generated: NOW.toISOString(), sports: {} };
  const backtests = {};
  const gamesById = {};

  for (const sport of ['cfb', 'nfl']) {
    const file = `games-${sport}.json`;
    const store = readJSON(file, { sport, season: null, games: {} });
    try {
      await refresh(sport, store);
      await backfill(sport, store);
    } catch (e) { errors.push(`${sport} fetch: ${e.message}`); log('ERROR', e.message); }
    store.updated = NOW.toISOString();
    writeJSON(file, store);
    gamesById[sport] = store.games;
    const games = Object.values(store.games);

    try {
      // 1. learn blend weights from the season-to-date walk-forward backtest
      const rows = backtestRows(games, sport);
      const params = tune(rows, sport, model.params[sport]);
      const prevW = model.params[sport]?.w;
      if (prevW != null && Math.abs(prevW - params.w) >= 0.05) model.log.unshift({ at: NOW.toISOString(), msg: `${CFG[sport].label} model weight ${prevW} → ${params.w} after ${params.n} backtest games` });
      model.params[sport] = { ...params, updated: NOW.toISOString() };
      const learned = learnThresholds(ledger, sport, model);
      model.thresholds[sport] = learned.thresholds;
      learned.log.forEach(msg => model.log.unshift({ at: NOW.toISOString(), msg }));
      backtests[sport] = { ...simulateBacktest(rows, sport, params, learned.thresholds), params };

      // 2. current ratings + projections for the upcoming slate
      const M = buildModel(games, sport, nowMs);
      const slateYmd = slateDay(sport);
      const slateId = `${sport}-${slateYmd}`;
      const publishAt = etToDate(slateYmd, RELEASE_HOUR_ET, 0);
      const slateGames = games.filter(g => etParts(g.date).ymd === slateYmd).sort((a, b) => a.date.localeCompare(b.date));
      const entries = [];
      const gameRows = [];
      for (const g of slateGames) {
        const comp = components(g, M, sport);
        const odds = g.state === 'pre' ? g.close : null;
        const proj = project(comp, g.close, sport, params);
        const cands = odds ? evaluate(g, proj, odds, sport) : [];
        if (odds) entries.push({ g, comp, proj, cands });
        const best = cands.slice().sort((a, b) => b.ev - a.ev)[0];
        const ph = proj.mu != null ? cands.find(c => c.market === 'ml' && c.side === 'home') : null;
        gameRows.push({
          id: g.id, kickoff: g.date, state: g.state, detail: g.detail, neutral: g.neutral, completed: g.completed,
          away: teamOut(g.away, g.as), home: teamOut(g.home, g.hs),
          line: g.close ? { spread: g.close.spread, total: g.close.total, mlHome: g.close.mlHome, mlAway: g.close.mlAway, provider: g.close.provider, openSpread: g.open?.spread ?? null, openTotal: g.open?.total ?? null } : null,
          model: { line: round(-proj.muModel, 1), fair: proj.mu != null ? round(-proj.mu, 1) : null, total: round(proj.totModel, 1), fairTotal: round(proj.tot, 1), homeWin: ph ? round(ph.win, 3) : null, qualified: comp.qualified, gp: [comp.gpA, comp.gpH] },
          best: best && comp.qualified ? { label: best.label, ev: round(best.ev, 4), win: round(best.win, 3), market: best.market } : null,
        });
      }

      // 3. publish (lock) the official card at release time
      let status = slateGames.length ? 'preview' : 'off';
      if (!ledger.slates[slateId] && nowMs >= publishAt.getTime() && slateGames.length) {
        const live = entries.filter(e => Date.parse(e.g.date) > nowMs + 5 * 60e3);
        if (live.length) {
          const publishedAt = NOW.toISOString();
          const card = selectPicks(live, sport, learned.thresholds);
          const picks = card.map(e => pickRecord(sport, slateId, slateYmd, e, publishedAt));
          const parlays = buildParlays(live).map(t => ({ ...t, id: `${slateId}:${t.type}`, slateId, sport, date: slateYmd, publishedAt, status: 'open', profit: null }));
          ledger.picks.push(...picks);
          ledger.parlays.push(...parlays);
          ledger.slates[slateId] = { sport, date: slateYmd, publishedAt, picks: picks.length, parlays: parlays.length, gamesConsidered: live.length, params: { a: params.a, w: params.w, at: params.at, wt: params.wt } };
          log(`${sport}: PUBLISHED ${slateId} — ${picks.length} picks, ${parlays.length} parlays`);
        } else {
          ledger.slates[slateId] = { sport, date: slateYmd, publishedAt: null, missed: true, picks: 0 };
        }
      }
      const pub = ledger.slates[slateId];
      if (pub) status = slateGames.every(g => g.completed || g.canceled) ? 'final' : 'official';
      const preview = !pub ? selectPicks(entries, sport, learned.thresholds).map(e => pickRecord(sport, slateId, slateYmd, e, null)) : [];

      board.sports[sport] = {
        sport, label: SLATE_LABEL[sport], slateId, date: slateYmd, status,
        publishAt: publishAt.toISOString(), publishedAt: pub?.publishedAt || null, missed: !!pub?.missed,
        picks: ledger.picks.filter(p => p.slateId === slateId),
        parlays: ledger.parlays.filter(t => t.slateId === slateId),
        preview, games: gameRows,
        params: { a: params.a, w: params.w, at: params.at, wt: params.wt, n: params.n },
      };
    } catch (e) { errors.push(`${sport} model: ${e.stack || e.message}`); log('ERROR', e.stack || e.message); }
  }

  const graded = gradeLedger(ledger, gamesById);
  if (graded) log(`graded ${graded} bets`);
  // refresh board copies of picks after grading
  for (const s of Object.values(board.sports)) {
    s.picks = ledger.picks.filter(p => p.slateId === s.slateId);
    s.parlays = ledger.parlays.filter(t => t.slateId === s.slateId);
  }
  const legacy = readJSON('legacy.json', null);
  const stats = {
    generated: NOW.toISOString(),
    live: liveStats(ledger),
    backtest: backtests,
    legacy: legacy ? summarize(legacy.picks.map(p => ({ ...p, units: 1, profit: 0 }))) : null,
    modelLog: model.log.slice(0, 40),
  };
  model.log = model.log.slice(0, 200);
  writeJSON('ledger.json', ledger);
  writeJSON('model.json', model);
  writeJSON('board.json', board);
  writeJSON('stats.json', stats);
  writeJSON('meta.json', { version: VERSION, lastRun: NOW.toISOString(), seconds: round((Date.now() - t0) / 1000, 1), requests: fetchStats().requests, errors });
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${fetchStats().requests} requests, ${errors.length} errors`);
  if (errors.length && Object.keys(board.sports).length === 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });

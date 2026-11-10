// Test harness: replaces global fetch with a deterministic fake ESPN feed.
// Usage: CR_NOW=2026-11-14T16:00:00Z CR_DATA_DIR=/tmp/x node --import ./engine/test/mock-fetch.mjs engine/run.mjs
const NOW = Date.parse(process.env.CR_NOW || new Date().toISOString());
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function league(nTeams, nFcs, sd, prefix) {
  const teams = [];
  for (let i = 0; i < nTeams; i++) teams.push({ id: `${prefix}${i}`, abbr: `${prefix}${i}`, r: gauss() * sd, conf: '8' });
  for (let i = 0; i < nFcs; i++) teams.push({ id: `F${prefix}${i}`, abbr: `F${prefix}${i}`, r: -20 + gauss() * 5, conf: '999' });
  return teams;
}
const L = {
  nfl: { teams: league(32, 0, 6, 'N'), day: 0, hfa: 1.8, sd: 13.5, weeks: 18, start: Date.parse('2026-09-13T17:00:00Z') },
  cfb: { teams: league(60, 12, 14, 'C'), day: 6, hfa: 2.8, sd: 16, weeks: 16, start: Date.parse('2026-08-29T16:00:00Z') },
};
const amer = p => (p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p));
function Phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989422804 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

const sched = {};
for (const [sport, cfg] of Object.entries(L)) {
  const games = [];
  for (let w = 1; w <= cfg.weeks; w++) {
    const fbs = cfg.teams.filter(t => t.conf !== '999').slice().sort(() => rnd() - 0.5);
    const fcs = cfg.teams.filter(t => t.conf === '999');
    const pairs = [];
    for (let i = 0; i + 1 < fbs.length; i += 2) pairs.push([fbs[i], fbs[i + 1]]);
    if (sport === 'cfb' && w <= 3) for (let i = 0; i < fcs.length && i < pairs.length; i++) pairs[i][0] = fcs[i];
    pairs.forEach(([a, h], i) => {
      const date = new Date(cfg.start + (w - 1) * 7 * 864e5 + (i % 3) * 3.5 * 3600e3);
      const trueMu = h.r - a.r + cfg.hfa;
      const mktMu = trueMu + gauss() * 2.5; // market is close to truth but noisy
      const margin = Math.round(trueMu + gauss() * cfg.sd);
      const total = Math.round(44 + gauss() * 10);
      const hs = Math.max(0, Math.round((total + margin) / 2)), as = Math.max(0, hs - margin);
      const spread = Math.round(-mktMu * 2) / 2;
      const pH = 1 - Phi((0.5 - mktMu) / cfg.sd);
      games.push({ id: `${sport}${w}x${i}`, w, date, a, h, hs, as, spread, total: Math.round((44 + gauss() * 2) * 2) / 2, mlH: amer(Math.min(0.95, pH + 0.02)), mlA: amer(Math.min(0.95, 1 - pH + 0.02)) });
    });
  }
  sched[sport] = games;
}
const state = g => (NOW >= g.date.getTime() + 4 * 3600e3 ? 'post' : NOW >= g.date.getTime() ? 'in' : 'pre');
const team = t => ({ id: t.id, abbreviation: t.abbr, shortDisplayName: t.abbr, displayName: t.abbr + ' Team', conferenceId: t.conf });
function event(sport, g) {
  const st = state(g);
  const odds = st === 'pre' ? [{ provider: { name: 'MockBook' }, details: g.spread === 0 ? 'EVEN' : g.spread < 0 ? `${g.h.abbr} ${g.spread}` : `${g.a.abbr} ${-g.spread}`, overUnder: g.total, spread: g.spread, moneyline: { home: { close: { odds: String(g.mlH) }, open: { odds: String(g.mlH) } }, away: { close: { odds: String(g.mlA) } } }, pointSpread: { home: { close: { line: String(g.spread), odds: '-110' } }, away: { close: { line: String(-g.spread), odds: '-110' } } }, total: { over: { close: { line: 'o' + g.total, odds: '-110' } }, under: { close: { line: 'u' + g.total, odds: '-110' } } } }] : [];
  return {
    id: g.id, date: g.date.toISOString(), week: { number: g.w }, season: { year: 2026, type: 2 },
    competitions: [{ neutralSite: false, status: { type: { state: st, completed: st === 'post', name: st === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', shortDetail: st } },
      competitors: [{ homeAway: 'home', team: team(g.h), score: st === 'pre' ? '0' : String(g.hs) }, { homeAway: 'away', team: team(g.a), score: st === 'pre' ? '0' : String(g.as) }], odds }],
  };
}
function curWeek(sport) { const c = L[sport]; return Math.max(1, Math.min(c.weeks, Math.floor((NOW - c.start + 2 * 864e5) / (7 * 864e5)) + 1)); }

globalThis.fetch = async url => {
  const u = new URL(url);
  const sport = u.pathname.includes('college-football') ? 'cfb' : 'nfl';
  let body;
  if (u.pathname.endsWith('/scoreboard')) {
    const w = u.searchParams.get('week') ? +u.searchParams.get('week') : curWeek(sport);
    body = { week: { number: curWeek(sport) }, season: { type: 2, year: 2026 }, events: sched[sport].filter(g => g.w === w).map(g => event(sport, g)) };
  } else if (u.pathname.endsWith('/odds')) {
    const id = u.pathname.split('/events/')[1].split('/')[0];
    const g = sched[sport].find(x => x.id === id);
    body = g ? { items: [{ provider: { name: 'MockBook' }, details: g.spread < 0 ? `${g.h.abbr} ${g.spread}` : `${g.a.abbr} ${-g.spread}`, overUnder: g.total, spread: g.spread, homeTeamOdds: { moneyLine: g.mlH, spreadOdds: -110 }, awayTeamOdds: { moneyLine: g.mlA, spreadOdds: -110 } }] } : { items: [] };
  } else return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

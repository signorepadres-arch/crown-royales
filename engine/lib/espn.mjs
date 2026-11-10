// ESPN public feed: scoreboards (schedule, scores, current line) and the core odds feed
// (used to backfill closing lines for games that already kicked off — the scoreboard
// drops odds once a game starts).
import { sleep } from './util.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues';

export const LEAGUES = {
  nfl: { path: 'nfl', extra: '', regWeeks: 18 },
  cfb: { path: 'college-football', extra: '&groups=80', regWeeks: 16 }, // groups=80 = FBS
};

// ESPN conference group ids for FBS (used to give FCS opponents a low prior rating).
const FBS_CONF = new Set(['1', '4', '5', '8', '9', '12', '15', '17', '18', '37', '151']);

let requestCount = 0;
export const stats = () => ({ requests: requestCount });

export async function fetchJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      requestCount++;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      lastErr = new Error(`HTTP ${r.status} ${url}`);
    } catch (e) { lastErr = e; }
    await sleep(700 * (i + 1));
  }
  throw lastErr || new Error('fetch failed ' + url);
}

export async function scoreboard(sport, opts = {}) {
  const L = LEAGUES[sport];
  let q = `limit=500${L.extra}`;
  if (opts.week != null) q += `&week=${opts.week}&seasontype=${opts.seasontype || 2}`;
  if (opts.season) q += `&dates=${opts.season}`;
  return fetchJSON(`${SITE}/${L.path}/scoreboard?${q}`);
}

export async function coreOdds(sport, eventId) {
  const L = LEAGUES[sport];
  const j = await fetchJSON(`${CORE}/${L.path}/events/${eventId}/competitions/${eventId}/odds?limit=20`);
  const items = j?.items || [];
  // Prefer an item with a real line; ESPN BET / DraftKings are usually first.
  return items.find(o => o && (o.details || o.spread != null || o.overUnder != null)) || null;
}

const num = v => {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'object') return num(v.american ?? v.value ?? v.alternateDisplayValue);
  const s = String(v).trim().replace(/^[ou]/i, '');
  if (!s || /^(off|n\/a|-)$/i.test(s)) return null;
  if (/^even$/i.test(s)) return 100;
  const n = parseFloat(s.replace('+', ''));
  return isFinite(n) ? n : null;
};
const firstNum = (...vals) => { for (const v of vals) { const n = num(v); if (n != null) return n; } return null; };

// Normalise one ESPN odds object (scoreboard or core shape) into home-relative numbers.
export function parseOdds(o, homeAbbr, awayAbbr) {
  if (!o) return null;
  let spread = null; // home team's line (negative = home favoured)
  const det = typeof o.details === 'string' ? o.details.trim() : '';
  if (/^(even|pk|pick)/i.test(det)) spread = 0;
  else {
    const m = det.match(/^(.+?)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (m) {
      const ab = m[1].trim().toUpperCase(), v = parseFloat(m[2]);
      if (homeAbbr && ab === homeAbbr.toUpperCase()) spread = v;
      else if (awayAbbr && ab === awayAbbr.toUpperCase()) spread = -v;
    }
  }
  if (spread == null) spread = firstNum(o.pointSpread?.home?.close?.line, o.pointSpread?.home?.current?.line);
  if (spread == null) spread = firstNum(o.spread); // ESPN's flat spread is home-relative

  const hml = firstNum(o.moneyline?.home?.close?.odds, o.moneyline?.home?.current?.odds, o.homeTeamOdds?.moneyLine, o.homeTeamOdds?.current?.moneyLine);
  const aml = firstNum(o.moneyline?.away?.close?.odds, o.moneyline?.away?.current?.odds, o.awayTeamOdds?.moneyLine, o.awayTeamOdds?.current?.moneyLine);
  const hso = firstNum(o.pointSpread?.home?.close?.odds, o.homeTeamOdds?.spreadOdds, o.homeTeamOdds?.current?.spread?.american);
  const aso = firstNum(o.pointSpread?.away?.close?.odds, o.awayTeamOdds?.spreadOdds, o.awayTeamOdds?.current?.spread?.american);
  const total = firstNum(o.overUnder, o.total?.over?.close?.line, o.total?.over?.current?.line);
  const ovo = firstNum(o.total?.over?.close?.odds, o.overOdds, o.current?.over?.american);
  const uno = firstNum(o.total?.under?.close?.odds, o.underOdds, o.current?.under?.american);

  const out = {
    provider: o.provider?.name || null,
    spread, spreadHomePrice: hso ?? (spread != null ? -110 : null), spreadAwayPrice: aso ?? (spread != null ? -110 : null),
    mlHome: hml, mlAway: aml,
    total, overPrice: ovo ?? (total != null ? -110 : null), underPrice: uno ?? (total != null ? -110 : null),
    open: {
      spread: firstNum(o.pointSpread?.home?.open?.line, o.homeTeamOdds?.open?.pointSpread?.american),
      total: firstNum(o.total?.over?.open?.line, o.open?.total?.american),
      mlHome: firstNum(o.moneyline?.home?.open?.odds, o.homeTeamOdds?.open?.moneyLine?.american),
      mlAway: firstNum(o.moneyline?.away?.open?.odds, o.awayTeamOdds?.open?.moneyLine?.american),
    },
  };
  // sanity: discard obviously broken prices
  for (const k of ['mlHome', 'mlAway', 'spreadHomePrice', 'spreadAwayPrice', 'overPrice', 'underPrice']) {
    if (out[k] != null && (Math.abs(out[k]) < 100 || Math.abs(out[k]) > 20000)) out[k] = null;
  }
  if (out.spread != null && Math.abs(out.spread) > 70) out.spread = null;
  if (out.total != null && (out.total < 20 || out.total > 110)) out.total = null;
  if (out.spread == null && out.mlHome == null && out.total == null) return null;
  return out;
}

function team(c) {
  const t = c.team || {};
  const rank = c.curatedRank?.current;
  return {
    id: String(t.id ?? t.abbreviation),
    abbr: t.abbreviation || t.shortDisplayName || '?',
    name: t.shortDisplayName || t.displayName || t.name || t.abbreviation,
    full: t.displayName || t.name || '',
    logo: t.logo || null,
    color: t.color || null,
    fbs: t.conferenceId != null ? FBS_CONF.has(String(t.conferenceId)) : null,
    rank: rank && rank < 99 ? rank : null,
    record: c.records?.[0]?.summary || null,
  };
}

export function parseEvent(ev) {
  const c = ev?.competitions?.[0];
  if (!c) return null;
  const h = c.competitors?.find(x => x.homeAway === 'home');
  const a = c.competitors?.find(x => x.homeAway === 'away');
  if (!h || !a) return null;
  const st = c.status?.type || ev.status?.type || {};
  const home = team(h), away = team(a);
  const name = String(st.name || '');
  return {
    id: String(ev.id),
    date: ev.date || c.date,
    week: ev.week?.number ?? null,
    seasonType: ev.season?.type ?? null,
    neutral: !!c.neutralSite,
    state: st.state || 'pre',
    completed: !!st.completed,
    canceled: /CANCEL|POSTPON|FORFEIT/i.test(name),
    detail: st.shortDetail || st.detail || '',
    home, away,
    hs: h.score != null && h.score !== '' ? Number(h.score) : null,
    as: a.score != null && a.score !== '' ? Number(a.score) : null,
    odds: parseOdds(c.odds?.[0], home.abbr, away.abbr),
  };
}

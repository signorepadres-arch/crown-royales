// Shared helpers: file IO, Eastern-time dates, odds math, normal distribution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA = process.env.CR_DATA_DIR || path.join(ROOT, 'data');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}
export function writeJSON(file, obj) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(obj, null, 1) + '\n');
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const round = (x, d = 2) => (x == null || !isFinite(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------- Eastern time ----------
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
});
export function etParts(d) {
  const p = {};
  for (const x of ET_FMT.formatToParts(d instanceof Date ? d : new Date(d))) p[x.type] = x.value;
  const hour = p.hour === '24' ? 0 : +p.hour;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`, hour, minute: +p.minute,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
export function addDaysYMD(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Convert an Eastern wall-clock time to a UTC Date (handles DST).
export function etToDate(ymd, hh = 0, mm = 0) {
  let guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hh + 5, mm);
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    const want = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hh, mm);
    const have = Date.UTC(+p.ymd.slice(0, 4), +p.ymd.slice(5, 7) - 1, +p.ymd.slice(8, 10), p.hour, p.minute);
    guess += want - have;
  }
  return new Date(guess);
}
export function seasonYear(now) {
  const d = new Date(now);
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// ---------- odds ----------
export const toDec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const implied = a => 1 / toDec(a);
export function decToAmerican(d) {
  if (!d || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
export function noVig(a, b) {
  const pa = implied(a), pb = implied(b);
  return [pa / (pa + pb), pb / (pa + pb)];
}
export const fmtAmerican = a => (a == null ? '' : a > 0 ? `+${a}` : `${a}`);
export const fmtLine = l => (l == null ? '' : l === 0 ? 'PK' : l > 0 ? `+${l}` : `${l}`);

// ---------- normal distribution ----------
export function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
export function PhiInv(p) {
  // Acklam's approximation
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  p = clamp(p, 1e-9, 1 - 1e-9);
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// X ~ N(mu, sd) on integer outcomes; a bet "X + line > 0" wins/pushes/loses with these probabilities.
export function lineProbs(mu, sd, line) {
  const t = -line;
  if (Math.abs(line - Math.round(line)) < 1e-9) {
    const win = 1 - Phi((t + 0.5 - mu) / sd);
    const push = Phi((t + 0.5 - mu) / sd) - Phi((t - 0.5 - mu) / sd);
    return { win, push, loss: Math.max(0, 1 - win - push) };
  }
  const win = 1 - Phi((t - mu) / sd);
  return { win, push: 0, loss: 1 - win };
}

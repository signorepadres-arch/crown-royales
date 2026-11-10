// Team ratings via weighted ridge regression (damped Jacobi iterations — no dependencies).
//  • margin ratings:  y = r_home - r_away + hfa·(!neutral)
//  • totals ratings:  y = 2·m + k_home + k_away

export function fitMargin(obs, { lambda, hfaPrior, hfaLambda = 20, prior = {}, iters = 120 }) {
  const teams = new Set();
  for (const g of obs) { teams.add(g.h); teams.add(g.a); }
  const r = {};
  for (const t of teams) r[t] = prior[t] || 0;
  let hfa = hfaPrior;
  for (let it = 0; it < iters; it++) {
    const num = {}, den = {};
    for (const t of teams) { num[t] = lambda * (prior[t] || 0); den[t] = lambda; }
    for (const g of obs) {
      const hv = g.neutral ? 0 : hfa;
      num[g.h] += g.w * (g.y + r[g.a] - hv); den[g.h] += g.w;
      num[g.a] += g.w * (r[g.h] + hv - g.y); den[g.a] += g.w;
    }
    for (const t of teams) r[t] = 0.5 * r[t] + 0.5 * (num[t] / den[t]);
    let hn = hfaLambda * hfaPrior, hd = hfaLambda;
    for (const g of obs) { if (g.neutral) continue; hn += g.w * (g.y - r[g.h] + r[g.a]); hd += g.w; }
    hfa = hn / hd;
  }
  return { r, hfa };
}

export function fitTotals(obs, { lambda, iters = 120 }) {
  const teams = new Set();
  let m = 0, wsum = 0;
  for (const g of obs) { teams.add(g.h); teams.add(g.a); m += g.w * g.y / 2; wsum += g.w; }
  m = wsum ? m / wsum : 22;
  const k = {};
  for (const t of teams) k[t] = 0;
  for (let it = 0; it < iters; it++) {
    const num = {}, den = {};
    for (const t of teams) { num[t] = 0; den[t] = lambda; }
    for (const g of obs) {
      num[g.h] += g.w * (g.y - 2 * m - k[g.a]); den[g.h] += g.w;
      num[g.a] += g.w * (g.y - 2 * m - k[g.h]); den[g.a] += g.w;
    }
    for (const t of teams) k[t] = 0.5 * k[t] + 0.5 * (num[t] / den[t]);
    let mn = 0;
    for (const g of obs) mn += g.w * (g.y - k[g.h] - k[g.a]) / 2;
    m = wsum ? mn / wsum : m;
  }
  return { k, m };
}

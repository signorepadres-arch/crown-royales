# Crown Royales

Saturday college football + Sunday NFL picks, priced against the market and graded automatically.
Live at https://crown-royales.vercel.app

## How it runs

```
GitHub Actions (cron, every ~3h + game-day extras)
  └─ node engine/run.mjs
       ├─ ESPN scoreboard  → schedule, scores, current line (saved before every kickoff = closing line)
       ├─ ESPN core odds   → true closing lines for games that already started
       ├─ ratings + model  → projections for the upcoming slate
       ├─ 10:00 AM ET on slate day → official card locked into data/ledger.json
       └─ grading, CLV, stats, self-tuning → data/*.json
  └─ commits data/ → Vercel redeploys the static site
```

No API keys, no build step, no dependencies (Node 20 only).

## Files

| Path | What |
|---|---|
| `index.html` | The site (This Week / Results / Model Lab). Reads `data/*.json`. |
| `engine/run.mjs` | One engine run. |
| `engine/lib/espn.mjs` | ESPN fetch + parsing. |
| `engine/lib/model.mjs` | Ratings, projections, bet pricing, pick selection, parlays, backtest tuning. |
| `engine/lib/grade.mjs` | Grading, closing-line value, summaries, threshold learning. |
| `engine/test/mock-fetch.mjs` | Fake ESPN feed for local testing. |
| `data/ledger.json` | Every official pick and parlay, with result, profit and CLV. Never edited by hand. |
| `data/games-*.json` | Season game store (scores + opening/closing lines). |
| `data/model.json` | Learned parameters and the learning log. |
| `data/legacy.json` | v1 manual picks (Sep 26 – Oct 3) and lessons. |

## The model in one paragraph

Team ratings are fit by ridge regression to this season's (capped, recency-weighted) margins and to past
closing lines. The model line mixes the two, then is blended part-way toward the current market line —
the blend weight is learned every run from a walk-forward backtest of the season. Every spread, moneyline
and total is priced off that blended line (normal margin distribution, push-aware), and only bets with
positive expected value above a minimum edge qualify, one per game. Tiers: Crown Royal (best bet, 6%+
edge), Crown (4%+), Lean. Stakes are quarter-Kelly, 0.5–3u. If a bet type keeps losing *and* keeps
losing to the closing line, its minimum edge rises automatically.

## Local test

```bash
CR_NOW=2026-11-14T15:30:00Z CR_DATA_DIR=/tmp/cr node --import ./engine/test/mock-fetch.mjs engine/run.mjs
```

Run the real engine manually from GitHub: **Actions → Crown Royales engine → Run workflow**.

## Settings worth knowing

- Release time: `RELEASE_HOUR_ET` in `engine/run.mjs` (default 10).
- Edge thresholds, guardrails, card size: `CFG` in `engine/lib/model.mjs`.
- Display unit size: `UNIT` in `index.html` (default $20).

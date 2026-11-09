# Dashboard hero load time

The dashboard hero arrived seconds after the widgets. This plan removes that wait without changing any figure.

## Cause

- `NetWorthHero` held its whole skeleton until the portfolio summary answered, for the sake of one figure (invested).
- The dashboard started the summary only after its first batch of requests finished, so the delay was the summary's full duration.
- `GET /portfolio/summary` walks every calendar day since the first investment to work out TWR and MWR. The dashboard reads none of the returns, except a TWR, MWR or CAGR chosen for the portfolio hero.
- During market hours the automatic price refresh started at the same moment as the summary.

## Assumptions

- The figures on the dashboard stay exactly what they were; only when they appear changes.
- `/portfolio/summary` keeps its response shape for its other consumers (Investments page, reports, Monte Carlo, AI and MCP tools).

## Changes

1. **Frontend.** `NetWorthHero` no longer waits for the valuation; invested keeps a placeholder. `PortfolioHero` draws once the valuation answers, with a placeholder for the chart, the change and a since-inception return.
2. **Frontend.** The dashboard's automatic price refresh waits for the valuation, as `useInvestmentData` waits for its summary.
3. **Backend and frontend.** `GET /portfolio/valuation` returns the summary without its return fields, in a separate shape because `null` on a return already means withheld. `getPortfolioSummary` is built on the same memoized valuation. The dashboard page and its widgets read the valuation.

## What to run

- `backend/`: `npm run lint`, `npx tsc --noEmit`, `npm run typecheck`, `npm run test:changed`.
- `frontend/`: `npm run lint`, `npm run type-check`, `npm run i18n:check`, `npm run test:changed`, `npm run build`.

## What should be observed

On a cold load, `portfolio/summary` is absent from the dashboard's requests unless the portfolio hero shows TWR, MWR or CAGR. The net worth hero appears with the widgets, with only invested still loading.

The task list is `docs/future-plans/dashboard-hero-load-tasks.md`.

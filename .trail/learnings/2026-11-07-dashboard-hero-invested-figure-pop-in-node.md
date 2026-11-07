---
title: "Dashboard hero invested-figure pop-in and mobile hero spacing (issue #2075)"
author: Node
date: 2026-11-07
branch: claude/issue-2075
cost: { minutes: 21, tokens: 251784 }
touches:
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/components/dashboard/DashboardHero.test.tsx
  - frontend/src/components/dashboard/DashboardHero.tsx
  - frontend/src/components/dashboard/NetWorthHero.test.tsx
  - frontend/src/components/dashboard/NetWorthHero.tsx
  - frontend/src/components/dashboard/hero-parts.tsx
  - frontend/src/components/layout/HelpMenu.tsx
  - frontend/src/components/layout/MobileNavDrawer.test.tsx
  - frontend/src/components/layout/MobileNavDrawer.tsx
  - frontend/src/hooks/useHelpMenuEntries.ts
---

## Decided
Dashboard page.tsx clears page-wide isLoading as soon as the first Promise.all (accounts, scheduled, net worth, favourite securities, securities list) resolves. The portfolio summary + top movers fetch fires right after, unawaited, in a separate Promise.all().then(). NetWorthHero's 'invested' sub-figure is the only sub-figure gated on portfolioSummary (hasInvestments && portfolioSummary), so it rendered a beat after net worth/assets/liabilities, which never depended on it.

Fix: added investmentSummaryLoading state in dashboard/page.tsx (true while the portfolio-summary fetch is in flight, only when hasInvestmentAccounts), threaded through DashboardHero -> NetWorthHero, and added it to NetWorthHero's existing HeroSkeleton gate ((hasInvestments && investmentSummaryLoading) alongside isLoading/dataLoading). Keeps the rest of the dashboard's isLoading fast (other widgets still render immediately); only the hero's own skeleton waits the extra beat.

## Tried and ruled out
Considered folding the portfolio-summary fetch into the main Promise.all so isLoading itself waits for it — rejected because isLoading gates every dashboard widget via widgetContext.isLoading, not just the hero, so this would add the portfolio-summary latency to the whole dashboard's first paint for a fix that only needs to affect the hero.

Considered reducing the mobile hero's blank space (second part of issue #2075) by applying a negative top margin to the chart's container div to cancel out HeroAreaChart's Recharts margin={{top: 36}} (reserved for the high/low flag bubble, portfolio-chart-utils.tsx renderChartFlagDot). Ruled out: that margin is internal SVG layout, untouched by an external CSS shift; shifting the whole chart box up would move the flag bubble (when shown) closer to/under the figures text above it, and I couldn't verify the real pixel risk without a live render. Settled for the lower-risk gap-y-4 -> gap-y-2 (mobile only) tweak on hero-parts.tsx's LAYOUT_CLASS instead, leaving the Recharts margin alone.

## Watch out
Could not get a live browser screenshot in this sandbox: docker-compose.dev.yml's backend OOMs on 'nest build' (default heap) under the 10Gi/6Gi container limits, and the environment's cached Playwright chromium (/workspace/home/.cache/ms-playwright) is missing ~20 shared libraries (libglib, libnss3, libgtk deps, etc.) — installing them via apt wasn't attempted (heavy, unauthorized scope). If someone needs to verify a Dashboard Hero visual change here, they'll hit the same wall; a project run-skill with apt deps baked in would fix this for next time.

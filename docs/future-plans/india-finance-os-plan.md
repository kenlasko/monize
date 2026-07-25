# India Finance OS Execution Plan

Status: EXECUTING
Author: Planning Session, 2026-07-25.
Owner: Kishore (trash.kishore@gmail.com).

Goal: Bring every feature of `finsight-ai` (/Users/kishore/git/finsight-ai) and `fintrack-app` (/Users/kishore/git/fintrack-app) into Monize, customized for Indian usage (INR, en-IN formatting, Indian categories, NSE/BSE/MF data), then ship images to GHCR (`ghcr.io/unplugged-kk/monize-{backend,frontend}`).

## Phase 0: Stabilize, Test, and Commit (Completed)
- [x] Migration 108: `database/migrations/108_user_preferences_inr_defaults.sql` altering column defaults for `user_preferences.default_currency` -> 'INR' and `number_format` -> 'en-IN'.
- [x] Schema verification: `scripts/verify-schema.sh` passed.
- [x] Unit tests: `mfapi.service.spec.ts` and `investment-analytics.service.spec.ts` passed with 100% coverage.
- [x] i18n checks: `npm run i18n:pseudo` and `npm run i18n:check` passed.
- [x] RLS ratchet: `npm run rls:ratchet` passed with 0 increases.

## Phase 1: Data Seeding / FinTrack Import
- [x] `scripts/migrate-fintrack.ts` updated and run against PostgreSQL database.

## Phase 2: Frontend INR Polish + XIRR/CAGR Badges
- [ ] Verify `en-IN` formatting and INR symbol across Next.js frontend.

## Phase 3: GHCR Build & Push
- [ ] Build and push production images to `ghcr.io/unplugged-kk`.

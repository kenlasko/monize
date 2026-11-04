---
title: "Money 99 (Jet 3) .mny: mdb-reader reads it natively, but its TRN.grftt bits and act codes are a different layout from Money Plus"
author: Ken
date: 2026-10-27
branch: main
id: l-9ab56e92
scope: repo
status: active
src: agent
---

## Decided
- Money 97-99 support goes into the existing native importer (`backend/src/import/mny/`), not a port of catrucho/Money-import's converter. `mdb-reader` 3.2.0 already reads Jet 3 (2 KB pages, cp1252 text, year-10000 "no date"); only `msisam/jet-header.ts` rejects the file ("Standard Jet DB", version byte 0). The Python `jet3.py`/`jet4.py`/template writer are not needed.
- With the header check bypassed, `readMnyTables` + the mappers already read accounts, payees, categories, transfers, splits and lots from a Money 99 file (measured on a small hand-built file, /home/ken/MSmoney99_template.mny, 77 TRN rows).

## Watch out
- Money 99 `TRN.grftt`, measured on that file (77 rows; small, so re-check on a real file): 0x4 transfer, 0x8 transfer receiving side, 0x20 split parent, 0x40 split child, 0x1 row in a loan account, 0x100 loan-payment template family (account-less parent + legs), 0x200 scheduled series, 0x800 originating leg of a series, 0x400 pending scheduled instance never posted (htrnSrc points to the frq != -1 template). Money Plus masks do not carry over: Plus VOID is 0x100, which is Money 99's loan-template bit, and Plus UNPOSTED (0x60000) misses Money 99's 0x400, so pending instances import as real future-dated rows. The converter script claims Money 99 VOID is 0x80; not yet observed.
- Money 99 `TRN.act`, confirmed by `LOT.htrnBuy` and cash pairing on that file: 0 buy, 4 cash dividend (Plus 4 is interest), 5 reinvest. 14 seen once with an income category and a cash pairing; meaning unconfirmed. Codes 1, 2, 4 mean different things in Money 99 and Plus, so the action table must be chosen per file version.
- Money 99 has no `BILL` table; scheduled items are `TRN` rows with `frq != -1`, and a scheduled transfer stores both legs.
- `DHD.hcrncDef` (USD) and `hcrncCur` (EUR) differ in that file while every non-loan account is EUR; which one is the base currency in Money 99 is unconfirmed.

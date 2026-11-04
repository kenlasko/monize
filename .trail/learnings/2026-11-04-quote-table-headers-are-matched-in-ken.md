---
title: "Quote-table headers are matched in every UI language, with a Unicode word end instead of \\b"
author: Ken
date: 2026-11-04
branch: fix/quote-table-form-and-header-languages
id: l-3194dc7c
scope: repo
status: active
src: agent
touches:
  - backend/src/securities/html-table-quote.headers.ts
  - backend/src/securities/html-table-quote.parser.spec.ts
  - backend/src/securities/html-table-quote.parser.ts
  - frontend/src/components/securities/SecurityForm.tsx
  - frontend/src/i18n/messages/de/securities.json
  - frontend/src/i18n/messages/en/securities.json
  - frontend/src/i18n/messages/es/securities.json
  - frontend/src/i18n/messages/fr/securities.json
  - frontend/src/i18n/messages/hi/securities.json
  - frontend/src/i18n/messages/id/securities.json
---

## Decided
- The web page table provider recognises date/close/open/high/low/volume header words in every language the UI is translated into (en, de, es, fr, it, pt, nl, pl, ru, uk, tr, vi, id, hi, ja, ko, zh). Ken asked for this rather than a help text listing the supported languages; the form help text no longer names languages.
- A generic price noun may lead a qualifier ("Cours de clôture", "Цена закрытия", "Giá mở cửa"), so open/high/low/close accept an optional price noun first.
- The generic close ranks ("Last", "Kurs", "Цена") skip any column that also matches open/high/low/volume, so "Kurs otwarcia" is the open, not the close.
- "Date" alone no longer hints a dot decimal: it is both English and French.

## Watch out
- JavaScript `\b` only knows ASCII word characters, so `preço\b` or `дата\b` can never match before the end of the text. Word ends are `(?![\p{L}\p{N}])` with the `u` flag.
- Lower-casing Turkish "İ" leaves a combining dot (U+0307); headerKey strips it.
- Japanese "調整後終値" and English "Adj Close" must not match close; Korean "시가" (open) is whole-word so "시가총액" (market cap) is not taken.
- Text month names are still only English/German/Spanish, so a page with French or Italian written-out dates finds its table but may skip rows.

In the code: backend/src/securities/html-table-quote.headers.ts (HEADER_WORDS, headerPattern, FIRST_GENERIC_CLOSE_RANK, DOT_HEADERS/COMMA_HEADERS), MONTH_NAMES in html-table-quote.parser.ts; regex escaping must go through backend/src/common/escape-regexp.util.ts (guard).

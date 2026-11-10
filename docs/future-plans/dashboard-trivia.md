# Dashboard hero cycling and daily trivia

The dashboard hero alternates between net worth and the portfolio, and a line of trivia about the reader's money sits beside the greeting.

## Assumptions

- The hero's two sets keep their figures; only how they are shown changes. A new `auto` choice is the default for a reader who never chose a set; a stored choice is kept.
- A delegate sees no hero, so the trivia endpoint is owner-only.
- A figure in a sentence is the server's, never a model's. A model chooses which facts to mention and writes the words around named placeholders; it cannot state a number.

## Changes

1. **Database.** `dashboard_trivia`, one row per user replaced whole each day: the list of items and the figures they quote. Direct RLS bucket. Excluded from backups as a regenerable cache, and wiped with the user's data.
2. **Backend.** `backend/src/ai/trivia/`: a pure fact sheet over the net worth history and the portfolio summary, each fact present only when every figure in it is known (a month that did not convert, or a valuation that is not complete, yields no fact). A daily cron stores one set per user under `claimOnce(DashboardTrivia, userId, "daily:<UTC day>")`. A user with an AI provider, other than the relay, gets the model's sentences; a topic the model gave nothing valid for keeps the calculated sentences. The relay is kept out of the call's provider fall-through. A user with the hero or `aiTriviaEnabled` switched off gets no list and no provider call, and a list with nothing in it is never stored. The model writes in the reader's language. The row stores it, so a reader whose preference is to follow the browser has that browser's locale at the next run, and a model's list in another language than the reader now uses is replaced by the calculated sentences until then. `GET /ai/trivia` returns the stored set, building and storing a calculated one when the user has none yet.
3. **Frontend.** `DashboardHero` holds the greeting still and slides the two sets on a track, every minute in Auto. The second set mounts 30 seconds after the first has loaded, so it never competes with the first paint. `DashboardTrivia` shows the facts for the set on screen, with a topic badge.

## Validating a model's sentence

A sentence is dropped when it names a placeholder that does not exist or belongs to the other topic, holds no placeholder, holds a numeral, a percent or currency sign or a brace outside a placeholder, or is over length. Names are never sent to the provider; the prompt describes them and the reader's browser fills them in.

## What to run

- `backend/`: `npm run lint`, `npx tsc --noEmit`, `npm run typecheck`, `npm run test:unit -- trivia`, `npm run migration:lint`.
- `frontend/`: `npm run lint`, `npm run type-check`, `npm run i18n:check`, the specs of the changed files.
- Root: `scripts/verify-schema.sh`.

## What should be observed

The hero slides between the two sets once a minute in Auto, with the greeting still. The trivia line changes with it and carries a Net worth or Investments badge. With no AI provider the sentences come from the translated catalog; with one, from the model, with figures in the reader's number format.

The task list is `docs/future-plans/dashboard-trivia-tasks.md`.

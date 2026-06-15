# Frontend translations

This folder holds per-locale UI strings for Monize. Each locale lives in its own
folder and is split into small JSON files (namespaces) so translation work can
be done in focused PRs.

## Adding a language (example: Spanish)

1. Copy `en/` to a new folder named for the language. Use the ISO 639-1 code
   (`es`) or a BCP 47 tag if you need a regional variant (`pt-BR`).

       cp -r en es

2. Translate every value in every JSON file. **Leave the keys alone.** If a key
   contains an ICU placeholder like `{count, plural, ...}`, preserve the
   structure but translate the surrounding text:

       "transactionCount": "{count, plural, one {# transaccion} other {# transacciones}}"

3. Add one entry to `frontend/src/i18n/config.ts`:

       { code: "es", label: "Espanol", dir: "ltr" }

4. Mirror the same steps in `backend/src/i18n/locales/` so server-rendered
   strings (error messages, email templates) are translated too.

5. Open a PR. No other code changes are needed.

## Regional variants (lean overrides)

A regional variant of an existing language (e.g. `en-GB`, `en-US`) does **not**
copy the whole catalog. It ships only the keys whose wording differs from its
base and inherits everything else per key at load time.

1. Add an entry to `frontend/src/i18n/config.ts` with a `base`:

       { code: "en-GB", label: "English (UK)", dir: "ltr", base: "en" }

2. Create `messages/en-GB/<namespace>.json` files containing **only** the
   changed leaves, mirroring the base's nested structure:

       // messages/en-GB/reports.json
       { "groupUncategorized": "Uncategorised" }

   Omit any namespace that has no changes -- the loader falls back to the base
   for missing files and missing keys (`loadNamespace` in `messages.ts` merges
   the variant over its base with `deepMerge`). A variant that differs in
   nothing (e.g. `en-CA`, which already matches our Canadian-flavoured `en`)
   needs no folder at all; listing it in config is enough.

3. The parity test checks variants as a *subset* of `en`: every key you add must
   exist in `en`, must actually change the value (no verbatim copies), and must
   keep the same ICU placeholders.

4. Mirror the same approach under `backend/src/i18n/locales/` for any
   server-rendered strings that differ (often none). The `xx` pseudo-locale is
   generated from `en` only, so variants never affect it.

## Testing locally

- Change the language in **Settings -> Preferences**.
- The pseudo-locale `xx` (visible in dev builds only) wraps every translated
  string with `[XX-...-XX]` markers, making it easy to spot strings that
  haven't been extracted yet.

## The pseudo-locale is generated -- do not hand-edit it

The `xx/` catalogs are generated from `en/` by a script. After editing any
`en/*.json` file, regenerate them:

    npm run i18n:pseudo

`npm run i18n:check` fails if `xx/` is out of date, so wire it into CI/pre-commit
to keep the two in sync. ICU placeholders (`{count}`, plural/select blocks) are
preserved; only the surrounding literal text is marked.

## Extracting strings in a component

Client components read strings through next-intl's `useTranslations`:

    'use client';
    import { useTranslations } from 'next-intl';

    export function MyComponent() {
      const t = useTranslations('auth');           // namespace
      return <button>{t('signIn.submit')}</button>; // -> "Sign in"
    }

For strings that embed markup (a link, a `<span>`), use `t.rich` with element
chunks instead of concatenating:

    t.rich('register.agreement', {
      terms: (chunks) => <a href="/terms">{chunks}</a>,
    });

Component tests resolve the real English catalog automatically (`test/render.tsx`
eagerly loads every `en/` namespace), so assertions on visible English text keep
working without mocking next-intl.

## Namespaces

The catalogue is split into small files by feature area. To add a new
namespace, add it to the `NAMESPACES` array in `src/i18n/messages.ts` and
create matching JSON files for every locale.

| Namespace               | Contents                                                  |
|-------------------------|-----------------------------------------------------------|
| `common`                | Shared UI primitives (buttons, dialogs, pagination, etc.) |
| `navigation`            | App header, mobile nav drawer, search, section links      |
| `layout`                | Banners (demo, delegation, offline, HTTPS), page headers  |
| `auth`                  | Login, register, forgot/reset/change password pages       |
| `settings`              | Settings pages (themes, preferences, security, AI, etc.)  |
| `dashboard`             | Dashboard widgets and summaries                           |
| `accounts`              | Accounts list, forms, loan payment setup                  |
| `transactions`          | Transaction list, forms, splits, bulk update              |
| `bills`                 | Bills and deposits, cash-flow forecast                    |
| `scheduledTransactions` | Scheduled transaction forms and occurrence overrides      |
| `budgets`               | Budget dashboard, wizard, categories, strategies          |
| `investments`           | Investment transactions and holdings                      |
| `securities`            | Securities list, forms, price/transaction history         |
| `reports`               | All report views (net worth, cash flow, investments, ...) |
| `insights`              | Insights list and detail                                  |
| `ai`                    | AI assistant UI chrome (not model prompts/output)         |
| `import`                | Transaction import wizard                                 |
| `categories`            | Categories list and forms                                 |
| `payees`                | Payees list, forms, alias/auto-assign dialogs             |
| `tags`                  | Tags list and forms                                       |
| `currencies`            | Currencies list and forms                                 |
| `admin`                 | User management (admin only)                              |

Most user-facing UI strings have been extracted. Remaining English literals are
limited to a few areas intentionally left for later: form-validation messages
defined in module-scope Zod schemas, and a small number of chart-internal labels.

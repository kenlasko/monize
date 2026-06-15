# Backend translations

This folder holds server-rendered translations: exception messages, validation
errors, email subjects, and any other string the API surfaces to a user. The
language is selected per request by `nestjs-i18n` using (in order): the
`?lang=` query parameter, the `x-locale` header (set by the frontend proxy),
the `NEXT_LOCALE` cookie, or the `Accept-Language` header.

## Adding a language (example: Spanish)

1. Copy the `en/` folder to the new language code:

       cp -r en es

2. Translate every value in every JSON file. Leave the keys alone.
3. Add the code to `SUPPORTED_LOCALE_CODES` in `backend/src/i18n/config.ts`.
4. Mirror the same change on the frontend: create
   `frontend/src/i18n/messages/es/` and add `es` to
   `frontend/src/i18n/config.ts`.
5. Open a PR. No other code changes are needed.

## Regional variants (lean overrides)

A regional variant (e.g. `en-US`) lists only the keys whose wording differs from
its base. nestjs-i18n falls back to `en` (via `fallbackLanguage` and the
`fallbacks` map in `i18n.module.ts`) for every other key, and for variants that
ship no folder at all.

1. Add the code to `SUPPORTED_LOCALE_CODES` and an entry to `LOCALE_BASES`
   (`{ "en-US": "en" }`) in `backend/src/i18n/config.ts`.
2. Create `locales/en-US/<file>.json` with only the changed keys, mirroring the
   base structure. Omit files (or the whole folder) that have no changes.
3. The parity test checks variants as a subset of `en` (keys must exist in `en`,
   values must differ, placeholders must match). Mirror the matching variant
   under `frontend/src/i18n/`.

## Namespaces

| File              | Contents                                                  |
|-------------------|-----------------------------------------------------------|
| `common.json`     | Shared phrases used in multiple modules                   |
| `errors.json`     | Exception messages (NotFoundException, BadRequest, ...)   |
| `validation.json` | class-validator messages (see `@i18nValidationMessage`)   |
| `emails.json`     | Email subjects, body fragments, button labels             |

Subsequent PRs will populate these as the backend services are migrated.

-- Widen the per-security quote-provider CHECK for the html_table provider.
--
-- Adds 'html_table' (daily prices read from a table on a web page the security
-- names in securities.quote_url) to the allowed set on the per-security override
-- (securities.quote_provider) only. The per-user default
-- (user_preferences.default_quote_provider) is deliberately left without it: a
-- default applies to every security without an override, and those name no
-- page, so a stored html_table default (from a restored or hand-edited row)
-- would silently stop pricing them all. Widen-only: every existing row stays
-- valid. VARCHAR(20) already fits the new value.

ALTER TABLE securities
  DROP CONSTRAINT IF EXISTS securities_quote_provider_check;
ALTER TABLE securities
  ADD CONSTRAINT securities_quote_provider_check
  CHECK (
    quote_provider IS NULL
    OR quote_provider IN ('yahoo', 'msn', 'lse', 'deutsche_boerse', 'html_table')
  );

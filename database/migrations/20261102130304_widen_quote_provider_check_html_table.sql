-- Widen the quote-provider CHECK constraints for the html_table provider.
--
-- Adds 'html_table' (daily prices read from a table on a web page the security
-- names in securities.quote_url) to the allowed set on the per-security override
-- (securities.quote_provider) and the per-user default
-- (user_preferences.default_quote_provider). The default accepts it only so both
-- constraints stay the same list as QUOTE_PROVIDER_NAMES; the preferences DTO
-- refuses it. Widen-only: every existing row stays valid. VARCHAR(20) already
-- fits the new value.

ALTER TABLE securities
  DROP CONSTRAINT IF EXISTS securities_quote_provider_check;
ALTER TABLE securities
  ADD CONSTRAINT securities_quote_provider_check
  CHECK (
    quote_provider IS NULL
    OR quote_provider IN ('yahoo', 'msn', 'lse', 'deutsche_boerse', 'html_table')
  );

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_default_quote_provider_check;
ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_default_quote_provider_check
  CHECK (
    default_quote_provider IN ('yahoo', 'msn', 'lse', 'deutsche_boerse', 'html_table')
  );

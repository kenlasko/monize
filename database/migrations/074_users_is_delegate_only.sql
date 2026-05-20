-- Track which users exist solely as owner-managed delegate identities
-- (created via the Shared Access flow, never went through /register to
-- become a full account in their own right). Hides them from admin
-- User Management and the delegate's own context list -- both surfaces
-- should treat them as "managed by their owner."
--
-- A delegate is no longer "only" when they claim the row via /register
-- (the claim path in AuthService clears this flag).
--
-- Backfill marks every existing user that looks delegate-managed today
-- (in account_delegates as delegate, owns no accounts, owns no
-- delegations, isn't admin, is still in the mustChangePassword=true
-- bootstrap state). That last filter keeps users who've actively chosen
-- a new password -- the most reliable signal we have, without a column,
-- that they're past the bootstrap phase.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_delegate_only BOOLEAN NOT NULL DEFAULT false;

UPDATE users u
SET is_delegate_only = true
WHERE u.is_delegate_only = false
  AND u.must_change_password = true
  AND u.role <> 'admin'
  AND EXISTS (
    SELECT 1 FROM account_delegates ad
    WHERE ad.delegate_user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM accounts a WHERE a.user_id = u.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM account_delegates o WHERE o.owner_user_id = u.id
  );

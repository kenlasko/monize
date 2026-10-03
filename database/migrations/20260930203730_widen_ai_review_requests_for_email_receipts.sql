-- Widen the AI review queue for the `email_receipt` kind
-- (docs/future-plans/email-receipts.md section 4, task D1).
--
-- Expand only, so the previous release keeps working against this schema during
-- a rolling deploy: the kind CHECK gains a value (a relaxed constraint), and the
-- new column is nullable. A request of the new kind points at the stored email
-- it was raised for; the reference is cleared, not the request, when the email
-- is deleted (ON DELETE SET NULL).
--
-- uq_ai_review_requests_open is deliberately NOT changed. Its predicate is what
-- the running release's `enqueue` ON CONFLICT infers, so widening or replacing it
-- would break the previous pods mid-rollout. Its consequence is the decision the
-- design records: one open request without a rule per transaction, so a receipt
-- whose transaction already has an open manual or receipt request is reported as
-- `review_conflict` by the application and reprocessed once that request closes.

ALTER TABLE ai_review_requests DROP CONSTRAINT IF EXISTS ck_ai_review_requests_kind;
ALTER TABLE ai_review_requests
    ADD CONSTRAINT ck_ai_review_requests_kind
    CHECK (kind IN ('transaction_review', 'email_receipt'));

ALTER TABLE ai_review_requests
    ADD COLUMN IF NOT EXISTS email_receipt_id UUID REFERENCES email_receipts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_review_requests_email_receipt
    ON ai_review_requests(email_receipt_id) WHERE email_receipt_id IS NOT NULL;

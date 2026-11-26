-- Repair the cash legs the QIF/OFX/CSV importer wrote for a brokerage with a
-- linked cash account before issue #2436 (PR #2443; this repair is #2445).
--
-- The importer used to write a transfer pair for such a trade's cash effect:
-- the real cash row in the linked cash account (is_transfer, linked to the
-- pair's other half) and a counterpart in the brokerage itself (is_transfer,
-- linked back), and it pointed the investment row's transaction_id at the
-- brokerage-side counterpart. Every edit, delete and VOID crossing reads
-- transaction_id as the cash leg, so editing an imported dividend without
-- changes deleted the counterpart, left the real cash row unlinked and wrote
-- a second one beside it. The importer now writes the shape
-- InvestmentTransactionsService.create and the Money writer produce: one plain
-- row in the cash account, named by transaction_id. This puts the rows already
-- written into that shape:
--
--   * the investment row's transaction_id points at the cash row;
--   * the cash row's transfer link is cleared (is_transfer = false,
--     linked_transaction_id = NULL); its amount and rate are kept;
--   * the cash row takes the investment row's side of the VOID boundary, which
--     the investment row owns (assertVoidTransitionAllowedOnRow refuses
--     voiding a cash leg on its own, and updateStatus carries a trade's VOID to
--     the row transaction_id names). On the old shape a trade voided from the
--     investment side reached only the counterpart, so a VOID trade can hold an
--     active cash row: it is voided here and the cash account's balance gives
--     back its amount, as applyVoidTransitionToMirrorLeg would have;
--   * the brokerage counterpart is deleted, and what it contributed to the
--     brokerage's current_balance is reversed;
--   * any tag on the counterpart moves to the cash row, the one that remains;
--   * the monthly_account_balances of every account whose balance moved (the
--     brokerage, and a cash account whose row was voided) are deleted: they are
--     derived, and NetWorthService rebuilds them on the next read (the pattern
--     of 164_recompute_investment_snapshots_1242).
--
-- Each balance moves by one atomic delta per account, and a row contributes
-- its amount unless it is VOID (INV-TRANSFER-001) or dated after its owner's
-- today, which never entered current_balance (deletionBalanceEffect,
-- backend/src/common/deletion-balance.util.ts). The owner's today is read as
-- users-by-timezone.util.ts resolves it: the preference, else the last client
-- zone, else UTC (an unknown zone name also reads as UTC).
--
-- Only the importer's exact shape is matched, so nothing another writer made
-- is touched: an investment row in an INVESTMENT_BROKERAGE account whose
-- transaction_id names a top-level, non-split transfer row in that same
-- account, mutually linked with a top-level, non-split transfer row in the
-- brokerage's linked cash account, which no other investment row names.
-- Natively entered trades and the Money writer never point transaction_id at
-- a row in the brokerage itself. Shared-expense ledger rows, on either side,
-- are never matched: the importer never writes one and
-- shared_protect_ledger_transaction refuses the change.
--
-- A matching row is left as it is, and its investment row's id raised in a
-- NOTICE for repair by hand, when:
--   * deleting the counterpart would destroy or orphan something a person or
--     another feature attached to it: an attachment, a warranty, an email
--     receipt, a scheduled occurrence it settled, a bank-sync match, a split
--     line linking it, or a shared-expense ledger link (whose RESTRICT foreign
--     key would abort the migration);
--   * the trade is active but its cash row is VOID: the old shape let the
--     cash register void the pair on its own, and whether the person meant to
--     void the trade or only its cash cannot be read from the rows. Voiding
--     the trade here would need a holdings rebuild, and restoring the cash
--     would undo what they did;
--   * the trade is VOID and its active cash row is RECONCILED: voiding it
--     would change a balance the person has reconciled.
-- A RECONCILED counterpart is still deleted: it is the phantom the repair
-- removes, whatever was reconciled against it.
--
-- Deleting a counterpart cascades its transaction_rule_applications and
-- ai_review_requests rows, which record work done on that row and have nothing
-- left to act on, and leaves its id in any email_receipts
-- candidate_transaction_ids, which the receipt reads by id and finds gone, as
-- after any deletion the app makes.
--
-- Not done here:
--   * the investment row's own exchange_rate, which the fixed importer now
--     also stores, is left as written; the cash row keeps the rate it was
--     converted at;
--   * a row the #2436 edit defect already damaged no longer has the shape: the
--     edit deleted the counterpart and wrote a second cash row, leaving the
--     original one in the cash account as a transfer with no link that no
--     investment row names, so the cash account counts the trade twice. Such a
--     row cannot be told apart from one a person wrote, so it is not changed;
--     the likely ones (beside a row an investment row of the brokerage names,
--     on the same date for the same amount) are raised in a NOTICE.
--
-- Re-runnable: a repaired investment row names a non-transfer row in another
-- account, so a second pass selects nothing.

DO $$
DECLARE
    repaired INTEGER;
    voided INTEGER;
    skipped_dependents UUID[];
    skipped_status UUID[];
    orphans UUID[];
BEGIN
    -- Dropped at commit; only a second pass inside one transaction finds it.
    IF to_regclass('pg_temp.heal_2445_shape') IS NOT NULL THEN
        DROP TABLE IF EXISTS pg_temp.heal_2445_shape;
    END IF;

    CREATE TEMP TABLE heal_2445_shape ON COMMIT DROP AS
    WITH shape AS (
        SELECT it.id AS investment_id,
               b.id AS counterpart_id,
               c.id AS cash_id,
               b.account_id AS brokerage_id,
               c.account_id AS cash_account_id,
               it.status = 'VOID' AS trade_void,
               COALESCE(c.status = 'VOID', false) AS cash_void,
               COALESCE(c.status = 'RECONCILED', false) AS cash_reconciled,
               COALESCE(b.status = 'VOID', false) AS counterpart_void,
               b.amount AS counterpart_amount,
               b.transaction_date AS counterpart_date,
               c.amount AS cash_amount,
               c.transaction_date AS cash_date,
               (now() AT TIME ZONE tz.zone)::date AS owner_today,
               (
                 EXISTS (SELECT 1 FROM transaction_attachments x WHERE x.transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM warranties x WHERE x.transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM email_receipts x WHERE x.transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM scheduled_transaction_postings x WHERE x.transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM bank_sync_imported_transactions x WHERE x.transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM transaction_splits x
                            WHERE x.transaction_id = b.id OR x.linked_transaction_id = b.id)
                 OR EXISTS (SELECT 1 FROM shared_ledger_links x WHERE x.transaction_id = b.id)
               ) AS has_dependents
        FROM investment_transactions it
        JOIN accounts a ON a.id = it.account_id
        JOIN transactions b ON b.id = it.transaction_id
        JOIN transactions c ON c.id = b.linked_transaction_id
        LEFT JOIN user_preferences p ON p.user_id = it.user_id
        CROSS JOIN LATERAL (
            SELECT COALESCE(
                     NULLIF(NULLIF(btrim(p.timezone), ''), 'browser'),
                     NULLIF(NULLIF(btrim(p.last_client_timezone), ''), 'browser'),
                     'UTC'
                   ) AS zone
        ) z
        CROSS JOIN LATERAL (
            SELECT CASE
                     WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = z.zone)
                       THEN z.zone
                     ELSE 'UTC'
                   END AS zone
        ) tz
        WHERE a.account_sub_type = 'INVESTMENT_BROKERAGE'
          AND a.linked_account_id IS NOT NULL
          AND a.shared_expense_group_id IS NULL
          AND b.account_id = it.account_id
          AND b.user_id = it.user_id
          AND b.is_transfer = true
          AND COALESCE(b.is_split, false) = false
          AND b.parent_transaction_id IS NULL
          AND b.shared_expense_posting_id IS NULL
          AND c.account_id = a.linked_account_id
          AND c.user_id = it.user_id
          AND c.is_transfer = true
          AND c.linked_transaction_id = b.id
          AND COALESCE(c.is_split, false) = false
          AND c.parent_transaction_id IS NULL
          AND c.shared_expense_posting_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM accounts ca
            WHERE ca.id = c.account_id
              AND ca.shared_expense_group_id IS NOT NULL
          )
          -- One investment row per counterpart and per cash row.
          AND NOT EXISTS (
            SELECT 1 FROM investment_transactions o
            WHERE o.id <> it.id
              AND o.transaction_id IN (b.id, c.id)
          )
    )
    SELECT s.*,
           CASE
             WHEN s.has_dependents THEN 'dependents'
             WHEN NOT s.trade_void AND s.cash_void THEN 'status'
             WHEN s.trade_void AND NOT s.cash_void AND s.cash_reconciled THEN 'status'
             ELSE 'repair'
           END AS disposition,
           s.trade_void AND NOT s.cash_void AS void_cash,
           -- What each row contributed to its account's current_balance.
           CASE WHEN NOT s.counterpart_void AND s.counterpart_date <= s.owner_today
                THEN s.counterpart_amount ELSE 0 END AS counterpart_contributed,
           CASE WHEN NOT s.cash_void AND s.cash_date <= s.owner_today
                THEN s.cash_amount ELSE 0 END AS cash_contributed
    FROM shape s;

    -- The investment row names the cash row before its counterpart goes, so
    -- the ON DELETE SET NULL below has nothing left to clear.
    UPDATE investment_transactions it
    SET transaction_id = h.cash_id
    FROM heal_2445_shape h
    WHERE h.disposition = 'repair'
      AND it.id = h.investment_id;
    GET DIAGNOSTICS repaired = ROW_COUNT;

    UPDATE transactions t
    SET is_transfer = false,
        linked_transaction_id = NULL,
        status = CASE WHEN h.void_cash THEN 'VOID' ELSE t.status END
    FROM heal_2445_shape h
    WHERE h.disposition = 'repair'
      AND t.id = h.cash_id;

    INSERT INTO transaction_tags (transaction_id, tag_id)
    SELECT h.cash_id, tt.tag_id
    FROM heal_2445_shape h
    JOIN transaction_tags tt ON tt.transaction_id = h.counterpart_id
    WHERE h.disposition = 'repair'
    ON CONFLICT DO NOTHING;

    -- The deleted counterpart gives back what it contributed to the brokerage,
    -- and a cash row this voided gives back what it contributed to the cash
    -- account.
    UPDATE accounts acc
    SET current_balance = acc.current_balance - d.delta
    FROM (
        SELECT account_id, SUM(amount) AS delta
        FROM (
            SELECT brokerage_id AS account_id, counterpart_contributed AS amount
            FROM heal_2445_shape
            WHERE disposition = 'repair'
            UNION ALL
            SELECT cash_account_id, cash_contributed
            FROM heal_2445_shape
            WHERE disposition = 'repair' AND void_cash
        ) moved
        GROUP BY account_id
    ) d
    WHERE acc.id = d.account_id
      AND d.delta <> 0;

    DELETE FROM transactions t
    USING heal_2445_shape h
    WHERE h.disposition = 'repair'
      AND t.id = h.counterpart_id;

    DELETE FROM monthly_account_balances mab
    USING heal_2445_shape h
    WHERE h.disposition = 'repair'
      AND (mab.account_id = h.brokerage_id
           OR (h.void_cash AND mab.account_id = h.cash_account_id));

    SELECT count(*) FILTER (WHERE disposition = 'repair' AND void_cash),
           array_agg(investment_id ORDER BY investment_id) FILTER (WHERE disposition = 'dependents'),
           array_agg(investment_id ORDER BY investment_id) FILTER (WHERE disposition = 'status')
      INTO voided, skipped_dependents, skipped_status
      FROM heal_2445_shape;

    IF repaired > 0 THEN
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: pointed % imported investment row(s) at their cash row and deleted the brokerage-side counterpart, voiding % cash row(s) whose trade was VOID (issue #2445)', repaired, voided;
    END IF;
    IF skipped_dependents IS NOT NULL THEN
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: left % investment row(s) unrepaired because something is attached to their brokerage-side counterpart; repair by hand: %', cardinality(skipped_dependents), skipped_dependents;
    END IF;
    IF skipped_status IS NOT NULL THEN
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: left % investment row(s) unrepaired because the trade and its cash row disagree about VOID (an active trade over a VOID cash row, or a VOID trade over a RECONCILED one); repair by hand: %', cardinality(skipped_status), skipped_status;
    END IF;

    -- The rows the #2436 edit defect already damaged: reported, never changed.
    SELECT array_agg(o.id ORDER BY o.id)
      INTO orphans
      FROM transactions o
      JOIN accounts brk ON brk.linked_account_id = o.account_id
                       AND brk.account_sub_type = 'INVESTMENT_BROKERAGE'
     WHERE o.is_transfer = true
       AND o.linked_transaction_id IS NULL
       AND o.parent_transaction_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM investment_transactions x WHERE x.transaction_id = o.id
       )
       AND EXISTS (
         SELECT 1
           FROM investment_transactions it
           JOIN transactions n ON n.id = it.transaction_id
          WHERE it.account_id = brk.id
            AND n.id <> o.id
            AND n.account_id = o.account_id
            AND n.transaction_date = o.transaction_date
            AND n.amount = o.amount
       );
    IF orphans IS NOT NULL THEN
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: % unlinked transfer row(s) in a linked cash account sit beside a trade''s cash row of the same date and amount, likely the original cash row an edit before #2436 orphaned (the trade is then counted twice); not changed, check by hand: %', cardinality(orphans), orphans;
    END IF;
END $$;

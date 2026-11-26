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
--     linked_transaction_id = NULL); its amount, rate and status are kept, so
--     the cash account's balance does not move;
--   * the brokerage counterpart is deleted, and what it contributed to the
--     brokerage's current_balance is reversed with an atomic delta: its
--     amount, unless it is VOID (INV-TRANSFER-001) or dated after the owner's
--     today, which never entered current_balance (deletionBalanceEffect,
--     backend/src/common/deletion-balance.util.ts). The owner's today is read
--     as users-by-timezone.util.ts resolves it: the preference, else the last
--     client zone, else UTC (an unknown zone name also reads as UTC);
--   * any tag on the counterpart moves to the cash row, the one that remains;
--   * the brokerage's monthly_account_balances rows are deleted: they are
--     derived and counted the counterpart, and NetWorthService rebuilds them
--     on the next read (the pattern of 164_recompute_investment_snapshots_1242).
--
-- Only the importer's exact shape is matched, so nothing another writer made
-- is touched: an investment row in an INVESTMENT_BROKERAGE account whose
-- transaction_id names a top-level, non-split transfer row in that same
-- account, mutually linked with a top-level, non-split transfer row in the
-- brokerage's linked cash account, which no other investment row names.
-- Natively entered trades and the Money writer never point transaction_id at
-- a row in the brokerage itself.
--
-- A matching counterpart is skipped, and its ids raised in a NOTICE, when
-- deleting it would destroy or orphan something a person or another feature
-- attached to it: an attachment, a warranty, an email receipt, a scheduled
-- occurrence it settled, a bank-sync match, a split line linking it, or a
-- shared-expense ledger link (whose RESTRICT foreign key would abort the
-- migration). Shared-expense ledger rows, on either side, are never matched:
-- the importer never writes one and shared_protect_ledger_transaction refuses
-- the change. A RECONCILED counterpart is still deleted: it is the phantom
-- the repair removes, whatever was reconciled against it.
--
-- Not done here: the investment row's own exchange_rate, which the fixed
-- importer now also stores, is left as written; the cash row keeps the rate it
-- was converted at.
--
-- Re-runnable: a repaired investment row names a non-transfer row in another
-- account, so a second pass selects nothing.

DO $$
DECLARE
    investment_ids UUID[];
    counterpart_ids UUID[];
    cash_ids UUID[];
    brokerage_ids UUID[];
    skipped_ids UUID[];
    repaired INTEGER;
BEGIN
    WITH shape AS (
        SELECT it.id AS investment_id,
               b.id AS counterpart_id,
               c.id AS cash_id,
               b.account_id AS brokerage_id,
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
    SELECT array_agg(investment_id ORDER BY investment_id) FILTER (WHERE NOT has_dependents),
           array_agg(counterpart_id ORDER BY investment_id) FILTER (WHERE NOT has_dependents),
           array_agg(cash_id ORDER BY investment_id) FILTER (WHERE NOT has_dependents),
           array_agg(DISTINCT brokerage_id) FILTER (WHERE NOT has_dependents),
           array_agg(counterpart_id ORDER BY investment_id) FILTER (WHERE has_dependents)
      INTO investment_ids, counterpart_ids, cash_ids, brokerage_ids, skipped_ids
      FROM shape;

    IF investment_ids IS NOT NULL THEN
        -- The investment row names the cash row before its counterpart goes,
        -- so the ON DELETE SET NULL below has nothing left to clear.
        UPDATE investment_transactions it
        SET transaction_id = r.cash_id
        FROM unnest(investment_ids, cash_ids) AS r(investment_id, cash_id)
        WHERE it.id = r.investment_id;

        UPDATE transactions
        SET is_transfer = false,
            linked_transaction_id = NULL
        WHERE id = ANY(cash_ids);

        INSERT INTO transaction_tags (transaction_id, tag_id)
        SELECT r.cash_id, tt.tag_id
        FROM unnest(counterpart_ids, cash_ids) AS r(counterpart_id, cash_id)
        JOIN transaction_tags tt ON tt.transaction_id = r.counterpart_id
        ON CONFLICT DO NOTHING;

        -- What each counterpart contributed: nothing when VOID or dated after
        -- its owner's today, its amount otherwise.
        UPDATE accounts acc
        SET current_balance = acc.current_balance - s.contributed
        FROM (
            SELECT b.account_id, SUM(b.amount) AS contributed
            FROM transactions b
            LEFT JOIN user_preferences p ON p.user_id = b.user_id
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
            WHERE b.id = ANY(counterpart_ids)
              AND (b.status IS NULL OR b.status <> 'VOID')
              AND b.transaction_date <= (now() AT TIME ZONE tz.zone)::date
            GROUP BY b.account_id
        ) s
        WHERE acc.id = s.account_id
          AND s.contributed <> 0;

        DELETE FROM transactions WHERE id = ANY(counterpart_ids);

        DELETE FROM monthly_account_balances WHERE account_id = ANY(brokerage_ids);

        repaired := cardinality(investment_ids);
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: pointed % imported investment row(s) at their cash row and deleted the brokerage-side counterpart (issue #2445)', repaired;
    END IF;

    IF skipped_ids IS NOT NULL THEN
        RAISE NOTICE 'heal_imported_investment_cash_leg_shape: left % brokerage-side counterpart(s) in place because something is attached to them; repair by hand: %', cardinality(skipped_ids), skipped_ids;
    END IF;
END $$;

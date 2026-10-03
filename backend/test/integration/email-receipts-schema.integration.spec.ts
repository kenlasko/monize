import * as fs from "fs";
import * as path from "path";
import { DataSource } from "typeorm";

import { compareMigrationFilenames } from "@/common/db/migration-filename";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The email-receipts tables as production has them: `database/schema.sql`
 * applied to a scratch database, and the two migrations replayed on the schema
 * as it was without them.
 *
 * Every other integration suite builds its schema from entity metadata, which
 * creates none of the CHECK constraints, so a CHECK is only ever proven here.
 * What this holds: the enumerated vocabularies and bounds of the three tables
 * (design section 4), the ingestion idempotency key, the cascade and SET NULL
 * rules, the widened `ai_review_requests` kind, and that the migrations and
 * schema.sql arrive at the same constraints.
 */
describe("email receipts schema (schema.sql and migrations)", () => {
  const SCRATCH_DB = "monize_email_receipts_schema_test";
  const SCRATCH_OLD_DB = "monize_email_receipts_upgrade_test";
  const ROOT = path.join(__dirname, "../../..");
  const SCHEMA = path.join(ROOT, "database/schema.sql");
  const MIGRATIONS = path.join(ROOT, "database/migrations");
  const OWN_MIGRATIONS = [
    "add_email_receipts",
    "widen_ai_review_requests_for_email_receipts",
    "add_email_receipt_oauth",
  ];

  let admin: DataSource;
  let db: DataSource;
  let upgraded: DataSource;
  let userId: string;
  let otherUserId: string;
  let mailboxId: string;
  let transactionId: string;

  const connect = async (database: string): Promise<DataSource> => {
    const ds = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      database,
      synchronize: false,
      dropSchema: false,
    } as never);
    await ds.initialize();
    return ds;
  };

  const recreate = async (name: string) => {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  };

  beforeAll(async () => {
    admin = await connect(
      (INTEGRATION_TYPEORM_OPTIONS as { database: string }).database,
    );
    await recreate(SCRATCH_DB);
    await recreate(SCRATCH_OLD_DB);

    db = await connect(SCRATCH_DB);
    await db.query(fs.readFileSync(SCHEMA, "utf8"));

    // The schema as it was before this feature: schema.sql with its email
    // receipts objects cut out is not derivable, so the upgrade path is proven
    // from the same schema.sql with the migrations replayed twice (each must be
    // a no-op on an up-to-date schema, and on its own output).
    upgraded = await connect(SCRATCH_OLD_DB);
    await upgraded.query(fs.readFileSync(SCHEMA, "utf8"));
    const files = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort(compareMigrationFilenames);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const file of files) {
        await upgraded.query(
          fs.readFileSync(path.join(MIGRATIONS, file), "utf8"),
        );
      }
    }

    userId = (await createTestUserDirect(db, { firstName: "A" })).id;
    otherUserId = (await createTestUserDirect(db, { firstName: "B" })).id;
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    const [account] = await db.query(
      `INSERT INTO accounts (user_id, account_type, name, currency_code)
       VALUES ($1, 'CHEQUING', 'Checking', 'USD') RETURNING id`,
      [userId],
    );
    const [tx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
       VALUES ($1, $2, '2026-03-10', -50, 'USD', 'UNRECONCILED') RETURNING id`,
      [userId, account.id],
    );
    transactionId = tx.id;
  });

  afterAll(async () => {
    await db?.destroy();
    await upgraded?.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH_OLD_DB}`);
    await admin?.destroy();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE email_receipts, email_receipt_parsers, email_receipt_mailboxes, ai_review_requests CASCADE`,
    );
    [{ id: mailboxId }] = await db.query(
      `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
       VALUES ($1, 'imap.example.com', 'r@example.com', 'cipher') RETURNING id`,
      [userId],
    );
  });

  const mailboxWith = (column: string, value: unknown, user = otherUserId) =>
    db.query(
      `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc, ${column})
       VALUES ($1, 'h', 'u', 'p', $2)`,
      [user, value],
    );

  const receipt = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      user_id: userId,
      mailbox_id: mailboxId,
      uid_validity: 1,
      uid: 1,
      from_address: "orders@shop.example.com",
      from_domain: "shop.example.com",
      subject: "Order",
      received_at: "2026-03-10T08:00:00Z",
      body_text: "Total 50",
      ...over,
    };
    const cols = Object.keys(row);
    return db.query(
      `INSERT INTO email_receipts (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      cols.map((c) => row[c]),
    );
  };

  const parserWith = (column: string, value: unknown) =>
    db.query(
      `INSERT INTO email_receipt_parsers (user_id, name, ${column}) VALUES ($1, 'p', $2)`,
      [userId, value],
    );

  describe("email_receipt_mailboxes", () => {
    it("holds at most one mailbox per user", async () => {
      await expect(mailboxWith("folder", "INBOX", userId)).rejects.toThrow(
        /uq_email_receipt_mailboxes_user/,
      );
      await mailboxWith("folder", "INBOX", otherUserId);
    });

    it("bounds the port, and admits only tls and starttls for security", async () => {
      await expect(mailboxWith("port", 0)).rejects.toThrow(
        /ck_email_receipt_mailboxes_port/,
      );
      await expect(mailboxWith("port", 65536)).rejects.toThrow(
        /ck_email_receipt_mailboxes_port/,
      );
      await expect(mailboxWith("security", "none")).rejects.toThrow(
        /ck_email_receipt_mailboxes_security/,
      );
      await expect(mailboxWith("security", "plain")).rejects.toThrow(
        /ck_email_receipt_mailboxes_security/,
      );
      await mailboxWith("security", "starttls");
    });

    it("admits only the three AI modes and defaults everything to the safe side", async () => {
      await expect(mailboxWith("ai_mode", "always")).rejects.toThrow(
        /ck_email_receipt_mailboxes_ai_mode/,
      );
      await mailboxWith("ai_mode", "on_demand");
      const [row] = await db.query(
        `SELECT port, security, folder, enabled, ai_mode, auto_apply, uid_validity, last_uid
           FROM email_receipt_mailboxes WHERE user_id = $1`,
        [userId],
      );
      expect(row).toEqual({
        port: 993,
        security: "tls",
        folder: "INBOX",
        enabled: false,
        ai_mode: "off",
        auto_apply: false,
        uid_validity: null,
        last_uid: null,
      });
    });

    describe("credentials (password or OAuth2)", () => {
      const insert = (over: Record<string, unknown>) => {
        const row: Record<string, unknown> = {
          user_id: otherUserId,
          host: "h",
          username: "u",
          ...over,
        };
        const cols = Object.keys(row);
        return db.query(
          `INSERT INTO email_receipt_mailboxes (${cols.join(", ")})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => row[c]),
        );
      };

      it("defaults an existing-style insert to a password mailbox", async () => {
        const [row] = await db.query(
          `SELECT auth_method, oauth_provider, oauth_refresh_token_enc, password_enc
             FROM email_receipt_mailboxes WHERE user_id = $1`,
          [userId],
        );
        expect(row).toEqual({
          auth_method: "password",
          oauth_provider: null,
          oauth_refresh_token_enc: null,
          password_enc: "cipher",
        });
      });

      it("admits a password mailbox and an OAuth2 one, with or without a refresh token", async () => {
        await insert({ password_enc: "p" });
        await db.query(
          `DELETE FROM email_receipt_mailboxes WHERE user_id = $1`,
          [otherUserId],
        );
        await insert({
          auth_method: "oauth2",
          oauth_provider: "google",
          oauth_refresh_token_enc: "r",
        });
        await db.query(
          `DELETE FROM email_receipt_mailboxes WHERE user_id = $1`,
          [otherUserId],
        );
        // Disconnected or revoked: the provider stays, the token is gone.
        await insert({ auth_method: "oauth2", oauth_provider: "microsoft" });
      });

      it("admits only the two auth methods and the two providers", async () => {
        await expect(
          insert({ password_enc: "p", auth_method: "kerberos" }),
        ).rejects.toThrow(/ck_email_receipt_mailboxes_auth_method/);
        await expect(
          insert({
            auth_method: "oauth2",
            oauth_provider: "yahoo",
          }),
        ).rejects.toThrow(/ck_email_receipt_mailboxes_oauth_provider/);
      });

      it.each([
        ["a password mailbox with no password", { auth_method: "password" }],
        [
          "a password mailbox that names a provider",
          { password_enc: "p", oauth_provider: "google" },
        ],
        [
          "a password mailbox that holds a refresh token",
          { password_enc: "p", oauth_refresh_token_enc: "r" },
        ],
        [
          "an OAuth2 mailbox with no provider",
          { auth_method: "oauth2", oauth_refresh_token_enc: "r" },
        ],
        [
          "an OAuth2 mailbox that also stores a password",
          {
            auth_method: "oauth2",
            oauth_provider: "google",
            oauth_refresh_token_enc: "r",
            password_enc: "p",
          },
        ],
      ])("refuses %s", async (_name, over) => {
        await expect(insert(over)).rejects.toThrow(
          /ck_email_receipt_mailboxes_credentials/,
        );
      });

      it("refuses switching a password row to OAuth2 without clearing the password", async () => {
        await expect(
          db.query(
            `UPDATE email_receipt_mailboxes
                SET auth_method = 'oauth2', oauth_provider = 'google'
              WHERE user_id = $1`,
            [userId],
          ),
        ).rejects.toThrow(/ck_email_receipt_mailboxes_credentials/);
        await db.query(
          `UPDATE email_receipt_mailboxes
              SET auth_method = 'oauth2', oauth_provider = 'google',
                  oauth_refresh_token_enc = 'r', password_enc = NULL
            WHERE user_id = $1`,
          [userId],
        );
      });
    });

    it("keeps last_error within 300 characters", async () => {
      await expect(mailboxWith("last_error", "x".repeat(301))).rejects.toThrow(
        /value too long/,
      );
    });

    it("carries a bigint cursor past 2^53", async () => {
      await db.query(
        `UPDATE email_receipt_mailboxes SET uid_validity = 4294967295, last_uid = 9007199254740993`,
      );
      const [row] = await db.query(
        `SELECT uid_validity::text AS v, last_uid::text AS u FROM email_receipt_mailboxes`,
      );
      expect(row).toEqual({ v: "4294967295", u: "9007199254740993" });
    });
  });

  describe("email_receipt_parsers", () => {
    it("holds 1 to 10 sender domains", async () => {
      await expect(parserWith("from_domains", [])).rejects.toThrow(
        /ck_email_receipt_parsers_from_domains/,
      );
      await expect(
        parserWith(
          "from_domains",
          Array.from({ length: 11 }, (_, i) => `d${i}.example.com`),
        ),
      ).rejects.toThrow(/ck_email_receipt_parsers_from_domains/);
      await parserWith(
        "from_domains",
        Array.from({ length: 10 }, (_, i) => `d${i}.example.com`),
      );
    });

    it("holds 0 to 10 subject words", async () => {
      await parserWith("subject_contains", []);
      await expect(
        parserWith(
          "subject_contains",
          Array.from({ length: 11 }, (_, i) => `w${i}`),
        ),
      ).rejects.toThrow(/ck_email_receipt_parsers_subject_contains/);
    });

    it("admits only draft|approved and manual|ai, and a positive revision", async () => {
      await expect(parserWith("status", "active")).rejects.toThrow(
        /ck_email_receipt_parsers_status/,
      );
      await expect(parserWith("source", "import")).rejects.toThrow(
        /ck_email_receipt_parsers_source/,
      );
      await expect(parserWith("revision", 0)).rejects.toThrow(
        /ck_email_receipt_parsers_revision/,
      );
      await parserWith("status", "approved");
      await parserWith("source", "ai");
      const [row] = await db.query(
        `SELECT status, source, definition, revision FROM email_receipt_parsers
          WHERE source = 'ai'`,
      );
      // Everything a parser is not told starts as an unapproved, empty draft.
      expect(row).toEqual({
        status: "draft",
        source: "ai",
        definition: {},
        revision: 1,
      });
    });

    it("keeps the parser when its payee is deleted", async () => {
      const [payee] = await db.query(
        `INSERT INTO payees (user_id, name) VALUES ($1, 'Shop') RETURNING id`,
        [userId],
      );
      await db.query(
        `INSERT INTO email_receipt_parsers (user_id, name, payee_id) VALUES ($1, 'p', $2)`,
        [userId, payee.id],
      );

      await db.query(`DELETE FROM payees WHERE id = $1`, [payee.id]);

      const [row] = await db.query(
        `SELECT payee_id FROM email_receipt_parsers`,
      );
      expect(row.payee_id).toBeNull();
    });
  });

  describe("email_receipts", () => {
    it("accepts every state of the pipeline and refuses any other", async () => {
      const states = [
        "pending",
        "skipped",
        "no_parser",
        "parse_failed",
        "unmatched",
        "ambiguous",
        "review_conflict",
        "review",
        "ignored",
      ];
      for (const [i, status] of states.entries()) {
        await receipt({ uid: i + 1, status });
      }
      await expect(receipt({ uid: 99, status: "applied" })).rejects.toThrow(
        /ck_email_receipts_status/,
      );
    });

    it("admits only the four match kinds, or none", async () => {
      await receipt({ uid: 1, match_kind: null });
      for (const [i, kind] of [
        "order_id",
        "amount_payee",
        "amount_only",
        "manual",
      ].entries()) {
        await receipt({ uid: i + 2, match_kind: kind });
      }
      await expect(receipt({ uid: 9, match_kind: "guess" })).rejects.toThrow(
        /ck_email_receipts_match_kind/,
      );
    });

    it("is ingested once per (mailbox, UIDVALIDITY, UID)", async () => {
      await receipt({ uid_validity: 7, uid: 5 });
      await expect(receipt({ uid_validity: 7, uid: 5 })).rejects.toThrow(
        /uq_email_receipts_message/,
      );
      // A different UIDVALIDITY is a different message, as is a different UID.
      await receipt({ uid_validity: 8, uid: 5 });
      await receipt({ uid_validity: 7, uid: 6 });

      // And the idempotent insert the poll uses writes nothing the second time.
      const insert = () =>
        db.query(
          `INSERT INTO email_receipts
             (user_id, mailbox_id, uid_validity, uid, from_address, from_domain, subject, received_at, body_text)
           VALUES ($1, $2, 7, 5, 'a@b', 'b', 's', now(), 't')
           ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING RETURNING id`,
          [userId, mailboxId],
        );
      expect(await insert()).toEqual([]);
    });

    it("caps the text at 100,000 characters", async () => {
      await receipt({ uid: 1, body_text: "x".repeat(100_000) });
      await expect(
        receipt({ uid: 2, body_text: "x".repeat(100_001) }),
      ).rejects.toThrow(/ck_email_receipts_body_length/);
    });

    it("holds at most 10 candidate transactions", async () => {
      const ids = Array.from(
        { length: 11 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );
      await receipt({ uid: 1, candidate_transaction_ids: ids.slice(0, 10) });
      await expect(
        receipt({ uid: 2, candidate_transaction_ids: ids }),
      ).rejects.toThrow(/ck_email_receipts_candidates/);
    });

    it("deletes with its mailbox, and keeps its row when the transaction or parser goes", async () => {
      const [parser] = await db.query(
        `INSERT INTO email_receipt_parsers (user_id, name) VALUES ($1, 'p') RETURNING id`,
        [userId],
      );
      await receipt({
        uid: 1,
        transaction_id: transactionId,
        parser_id: parser.id,
      });

      await db.query(`DELETE FROM transactions WHERE id = $1`, [transactionId]);
      await db.query(`DELETE FROM email_receipt_parsers WHERE id = $1`, [
        parser.id,
      ]);
      const [kept] = await db.query(
        `SELECT transaction_id, parser_id FROM email_receipts`,
      );
      expect(kept).toEqual({ transaction_id: null, parser_id: null });

      await db.query(`DELETE FROM email_receipt_mailboxes WHERE id = $1`, [
        mailboxId,
      ]);
      expect(await db.query(`SELECT 1 FROM email_receipts`)).toEqual([]);
    });
  });

  describe("ai_review_requests, widened", () => {
    it("admits kind email_receipt and transaction_review, and refuses any other", async () => {
      // The transaction above may have been removed by an earlier case.
      const [account] = await db.query(`SELECT id FROM accounts LIMIT 1`);
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -5, 'USD', 'UNRECONCILED') RETURNING id`,
        [userId, account.id],
      );
      const insert = (kind: string) =>
        db.query(
          `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction)
           VALUES ($1, $2, $3, 'x')`,
          [userId, tx.id, kind],
        );
      await insert("email_receipt");
      await insert("transaction_review");
      await expect(insert("something_else")).rejects.toThrow(
        /ck_ai_review_requests_kind/,
      );
    });

    it("keeps the request when its email is deleted, clearing the reference", async () => {
      const [account] = await db.query(`SELECT id FROM accounts LIMIT 1`);
      const [tx] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
         VALUES ($1, $2, '2026-03-10', -5, 'USD', 'UNRECONCILED') RETURNING id`,
        [userId, account.id],
      );
      const [{ id: receiptId }] = await receipt({ uid: 1 });
      await db.query(
        `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, email_receipt_id)
         VALUES ($1, $2, 'email_receipt', 'x', $3)`,
        [userId, tx.id, receiptId],
      );

      await db.query(`DELETE FROM email_receipts WHERE id = $1`, [receiptId]);

      const [row] = await db.query(
        `SELECT email_receipt_id FROM ai_review_requests`,
      );
      expect(row.email_receipt_id).toBeNull();
    });

    it("still dedupes by (transaction, rule) exactly as before: the unique index is untouched", async () => {
      const [{ indexdef }] = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_ai_review_requests_open'`,
      );
      expect(indexdef).toMatch(/\(transaction_id, rule_id\)/);
      expect(indexdef).toMatch(/'pending'.*'claimed'.*'proposed'/);
    });
  });

  describe("row-level security", () => {
    it.each([
      "email_receipt_mailboxes",
      "email_receipt_parsers",
      "email_receipts",
    ])("%s has its direct policy and RLS enabled", async (table) => {
      const [{ relrowsecurity }] = await db.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      const [policy] = await db.query(
        `SELECT policyname, qual FROM pg_policies WHERE tablename = $1`,
        [table],
      );
      expect(relrowsecurity).toBe(true);
      expect(policy.policyname).toBe(`${table}_isolation`);
      expect(policy.qual).toMatch(/app_current_user_id/);
    });
  });

  describe("schema.sql and the migrations agree", () => {
    const constraints = (ds: DataSource) =>
      ds.query(
        `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid::regclass::text IN
                ('email_receipt_mailboxes', 'email_receipt_parsers',
                 'email_receipts', 'ai_review_requests')
          ORDER BY 1, 2`,
      );

    it("leaves every constraint of the four tables as schema.sql states it, after two replays", async () => {
      expect(await constraints(upgraded)).toEqual(await constraints(db));
    });

    it("has both migrations on disk, timestamp-prefixed, widening after creating", () => {
      const files = fs.readdirSync(MIGRATIONS).sort(compareMigrationFilenames);
      const positions = OWN_MIGRATIONS.map((name) =>
        files.findIndex((f) => f.endsWith(`_${name}.sql`)),
      );
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions[0]).toBeLessThan(positions[1]);
    });
  });
});

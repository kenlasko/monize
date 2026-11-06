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
    "email_receipts_html_and_forwarded",
    "ai_review_requests_parser_draft",
    "email_receipts_match_kind_profile",
    "email_receipt_mailbox_profile_ai_limit",
    "email_receipt_links",
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
        `SELECT port, security, folder, enabled, ai_mode, auto_apply,
                profile_proposals_count_toward_ai_limit, uid_validity, last_uid
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
        // The user's own switch defaults to today's behaviour: every confirm counts.
        profile_proposals_count_toward_ai_limit: true,
        uid_validity: null,
        last_uid: null,
      });
    });

    it("holds the switch for profile proposals NOT NULL, so no row reads as undecided", async () => {
      await expect(
        mailboxWith("profile_proposals_count_toward_ai_limit", null),
      ).rejects.toThrow(/not-null|null value/);
      await mailboxWith("profile_proposals_count_toward_ai_limit", false);
      const [row] = await db.query(
        `SELECT profile_proposals_count_toward_ai_limit AS counts
           FROM email_receipt_mailboxes WHERE user_id = $1`,
        [otherUserId],
      );
      expect(row.counts).toBe(false);
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

  describe("email_receipt_links", () => {
    const OUTCOMES = [
      "no_link",
      "not_found",
      "component_incomplete",
      "component_used",
      "joined",
      "scaled",
      "amount_exceeds",
    ];

    const link = (settlementId: string, over: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        user_id: userId,
        settlement_receipt_id: settlementId,
        part_index: 0,
        part_amount: "10.0000",
        outcome: "no_link",
        ...over,
      };
      const cols = Object.keys(row);
      return db.query(
        `INSERT INTO email_receipt_links (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        cols.map((c) => row[c]),
      );
    };

    let settlementId: string;
    let componentId: string;

    beforeEach(async () => {
      [{ id: settlementId }] = await receipt({ uid: 1 });
      [{ id: componentId }] = await receipt({
        uid: 2,
        status: "component",
        link_key: "k1",
      });
    });

    it("bounds the part index to 0..99 and holds one row per part of a settlement", async () => {
      await link(settlementId, { part_index: 0 });
      await link(settlementId, { part_index: 99 });
      await expect(link(settlementId, { part_index: 100 })).rejects.toThrow(
        /ck_email_receipt_links_part_index/,
      );
      await expect(link(settlementId, { part_index: -1 })).rejects.toThrow(
        /ck_email_receipt_links_part_index/,
      );
      await expect(link(settlementId, { part_index: 0 })).rejects.toThrow(
        /uq_email_receipt_links_part/,
      );
    });

    it("admits only the seven outcomes of a part", async () => {
      for (const [i, outcome] of OUTCOMES.entries()) {
        await link(settlementId, { part_index: i, outcome });
      }
      await expect(
        link(settlementId, { part_index: 50, outcome: "guess" }),
      ).rejects.toThrow(/ck_email_receipt_links_outcome/);
    });

    it("refuses a negative part amount and holds eight decimals", async () => {
      await expect(
        link(settlementId, { part_amount: "-0.0001" }),
      ).rejects.toThrow(/ck_email_receipt_links_part_amount/);
      await link(settlementId, { part_index: 1, part_amount: "0" });
      await link(settlementId, { part_index: 2, part_amount: "109.8900" });
      const rows = await db.query(
        `SELECT part_amount FROM email_receipt_links WHERE part_index = 2`,
      );
      expect(rows[0].part_amount).toBe("109.89000000");
    });

    it("leaves a part with no link value or component as it is, and defaults to the safe outcome", async () => {
      await db.query(
        `INSERT INTO email_receipt_links (user_id, settlement_receipt_id, part_amount)
         VALUES ($1, $2, 1)`,
        [userId, settlementId],
      );
      const [row] = await db.query(
        `SELECT part_index, link_value, component_receipt_id, outcome
           FROM email_receipt_links`,
      );
      expect(row).toEqual({
        part_index: 0,
        link_value: null,
        component_receipt_id: null,
        outcome: "no_link",
      });
    });

    it("is deleted with its settlement, and only loses its component when the component is deleted", async () => {
      await link(settlementId, {
        part_index: 0,
        link_value: "k1",
        component_receipt_id: componentId,
        outcome: "joined",
      });

      await db.query(`DELETE FROM email_receipts WHERE id = $1`, [componentId]);
      const [kept] = await db.query(
        `SELECT component_receipt_id, outcome FROM email_receipt_links`,
      );
      expect(kept).toEqual({ component_receipt_id: null, outcome: "joined" });

      await db.query(`DELETE FROM email_receipts WHERE id = $1`, [
        settlementId,
      ]);
      expect(await db.query(`SELECT 1 FROM email_receipt_links`)).toHaveLength(
        0,
      );
    });

    it("is deleted with its user", async () => {
      const gone = (await createTestUserDirect(db, { firstName: "G" })).id;
      const [{ id: mb }] = await db.query(
        `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
         VALUES ($1, 'h', 'u', 'p') RETURNING id`,
        [gone],
      );
      const [{ id: rid }] = await receipt({
        uid: 7,
        user_id: gone,
        mailbox_id: mb,
      });
      await link(rid, { user_id: gone });
      await db.query(`DELETE FROM users WHERE id = $1`, [gone]);
      expect(await db.query(`SELECT 1 FROM email_receipt_links`)).toHaveLength(
        0,
      );
    });

    it("keeps the link value of a component in its own column, and admits it only as text up to 100", async () => {
      await receipt({ uid: 3, status: "component", link_key: "x".repeat(100) });
      await expect(
        receipt({ uid: 4, status: "component", link_key: "x".repeat(101) }),
      ).rejects.toThrow(/value too long/);
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
        "component",
      ];
      for (const [i, status] of states.entries()) {
        await receipt({ uid: i + 1, status });
      }
      await expect(receipt({ uid: 99, status: "applied" })).rejects.toThrow(
        /ck_email_receipts_status/,
      );
    });

    it("admits only the six match kinds, or none (amount_only is what rows matched before the strategies were configurable carry)", async () => {
      await receipt({ uid: 1, match_kind: null });
      for (const [i, kind] of [
        "order_id",
        "reference",
        "amount_payee",
        "amount_date",
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

    it("keeps an HTML part of up to 1,000,000 characters, or none, and refuses more", async () => {
      await receipt({ uid: 1 });
      await receipt({ uid: 2, body_html: "<p>x</p>" });
      await receipt({ uid: 3, body_html: "x".repeat(1_000_000) });
      await expect(
        receipt({ uid: 4, body_html: "x".repeat(1_000_001) }),
      ).rejects.toThrow(/ck_email_receipts_body_html_length/);
      const rows = await db.query(
        `SELECT uid, body_html IS NULL AS none FROM email_receipts ORDER BY uid`,
      );
      expect(rows.map((r: { none: boolean }) => r.none)).toEqual([
        true,
        false,
        false,
      ]);
    });

    it("stores who forwarded an email and when the shop sent it, both optional", async () => {
      await receipt({
        uid: 1,
        forwarded_by: "alice.example@gmail.example.com",
        original_sent_at: "2026-08-10T08:15:00Z",
      });
      await receipt({ uid: 2 });
      const rows = await db.query(
        `SELECT forwarded_by, original_sent_at FROM email_receipts ORDER BY uid`,
      );
      expect(rows[0].forwarded_by).toBe("alice.example@gmail.example.com");
      expect(new Date(rows[0].original_sent_at).toISOString()).toBe(
        "2026-08-10T08:15:00.000Z",
      );
      expect(rows[1]).toEqual({ forwarded_by: null, original_sent_at: null });
      await expect(
        receipt({ uid: 3, forwarded_by: "x".repeat(321) }),
      ).rejects.toThrow(/value too long/);
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

    describe("kind email_parser_draft", () => {
      const R1 = "00000000-0000-4000-8000-000000000001";
      const draft = (over: Record<string, unknown> = {}, user = userId) => {
        const row: Record<string, unknown> = {
          user_id: user,
          kind: "email_parser_draft",
          instruction: "Write a parser",
          email_receipt_ids: [R1],
          parser_domain: "shop.example.com",
          ...over,
        };
        const cols = Object.keys(row);
        return db.query(
          `INSERT INTO ai_review_requests (${cols.join(", ")})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
          cols.map((c) => row[c]),
        );
      };

      it("is admitted with no transaction, its emails and its sender domain", async () => {
        const [row] = await draft();
        expect(row.id).toBeDefined();
        const [stored] = await db.query(
          `SELECT transaction_id, email_receipt_ids, parser_domain FROM ai_review_requests`,
        );
        expect(stored).toEqual({
          transaction_id: null,
          email_receipt_ids: [R1],
          parser_domain: "shop.example.com",
        });
      });

      it("holds one to 25 emails, no more, and never none", async () => {
        const ids = (n: number) =>
          Array.from(
            { length: n },
            (_, i) =>
              `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          );
        await draft({
          email_receipt_ids: ids(25),
          parser_domain: "a.example.com",
        });
        await expect(
          draft({ email_receipt_ids: ids(26), parser_domain: "b.example.com" }),
        ).rejects.toThrow(/ck_ai_review_requests_email_receipt_ids/);
        await expect(
          draft({ email_receipt_ids: [], parser_domain: "c.example.com" }),
        ).rejects.toThrow(/ck_ai_review_requests_parser_draft_shape/);
        await expect(
          draft({ email_receipt_ids: null, parser_domain: "d.example.com" }),
        ).rejects.toThrow(/ck_ai_review_requests_parser_draft_shape/);
      });

      it("needs a sender domain, and refuses a transaction", async () => {
        await expect(draft({ parser_domain: null })).rejects.toThrow(
          /ck_ai_review_requests_parser_draft_shape/,
        );
        const [account] = await db.query(`SELECT id FROM accounts LIMIT 1`);
        const [tx] = await db.query(
          `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
           VALUES ($1, $2, '2026-03-10', -5, 'USD', 'UNRECONCILED') RETURNING id`,
          [userId, account.id],
        );
        await expect(draft({ transaction_id: tx.id })).rejects.toThrow(
          /ck_ai_review_requests_parser_draft_shape/,
        );
      });

      it("is the only kind that may omit its transaction, and the others may not carry the draft columns", async () => {
        const bare = (kind: string, extra = "") =>
          db.query(
            `INSERT INTO ai_review_requests (user_id, kind, instruction${extra ? ", " + extra.split("=")[0] : ""})
             VALUES ($1, $2, 'x'${extra ? ", " + extra.split("=")[1] : ""})`,
            [userId, kind],
          );
        await expect(bare("transaction_review")).rejects.toThrow(
          /ck_ai_review_requests_transaction_required|null value/,
        );
        await expect(bare("email_receipt")).rejects.toThrow(
          /ck_ai_review_requests_transaction_required|null value/,
        );
        const [account] = await db.query(`SELECT id FROM accounts LIMIT 1`);
        const [tx] = await db.query(
          `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
           VALUES ($1, $2, '2026-03-10', -5, 'USD', 'UNRECONCILED') RETURNING id`,
          [userId, account.id],
        );
        await expect(
          db.query(
            `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, parser_domain)
             VALUES ($1, $2, 'transaction_review', 'x', 'shop.example.com')`,
            [userId, tx.id],
          ),
        ).rejects.toThrow(/ck_ai_review_requests_parser_draft_shape/);
        await expect(
          db.query(
            `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, email_receipt_ids)
             VALUES ($1, $2, 'email_receipt', 'x', ARRAY[$3]::uuid[])`,
            [userId, tx.id, R1],
          ),
        ).rejects.toThrow(/ck_ai_review_requests_parser_draft_shape/);
      });

      it("holds one OPEN request per user and sender domain, and any number once closed or for another sender or user", async () => {
        await draft();
        await expect(draft()).rejects.toThrow(
          /uq_ai_review_requests_parser_draft_open/,
        );
        // another sender, another user
        await draft({ parser_domain: "other.example.org" });
        await draft({}, otherUserId);
        // a closed one does not hold the slot
        await db.query(
          `UPDATE ai_review_requests SET status = 'rejected' WHERE user_id = $1 AND parser_domain = 'shop.example.com'`,
          [userId],
        );
        await draft();
        await draft({ status: "applied" });
        await draft({ status: "expired" });
        const open = await db.query(
          `SELECT 1 FROM ai_review_requests
            WHERE user_id = $1 AND parser_domain = 'shop.example.com'
              AND status IN ('pending', 'claimed', 'proposed')`,
          [userId],
        );
        expect(open).toHaveLength(1);
      });

      it("never conflicts in the (transaction, rule) index: NULL transaction ids are distinct", async () => {
        await draft({ parser_domain: "a.example.com" });
        await draft({ parser_domain: "b.example.com" });
        const [{ n }] = await db.query(
          `SELECT COUNT(*)::int AS n FROM ai_review_requests WHERE transaction_id IS NULL`,
        );
        expect(n).toBe(2);
      });

      it("deletes with its user, like every request", async () => {
        await draft({}, otherUserId);
        await db.query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
        expect(
          await db.query(
            `SELECT 1 FROM ai_review_requests WHERE kind = 'email_parser_draft'`,
          ),
        ).toEqual([]);
      });
    });

    it("still dedupes by (transaction, rule) exactly as before: the unique index is untouched", async () => {
      const [{ indexdef }] = await db.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_ai_review_requests_open'`,
      );
      expect(indexdef).toMatch(/\(transaction_id, rule_id\)/);
      expect(indexdef).toMatch(/'pending'.*'claimed'.*'proposed'/);
    });

    it("admits email_parser_draft in the kind vocabulary and still refuses any other", async () => {
      const [{ def }] = await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_ai_review_requests_kind'`,
      );
      expect(def).toContain("email_parser_draft");
      expect(def).toContain("email_receipt");
      expect(def).toContain("transaction_review");
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
                 'email_receipts', 'ai_review_requests', 'email_receipt_links')
          ORDER BY 1, 2`,
      );

    it("leaves every constraint of the four tables as schema.sql states it, after two replays", async () => {
      expect(await constraints(upgraded)).toEqual(await constraints(db));
    });

    it("has every migration of the feature on disk, timestamp-prefixed, widening after creating", () => {
      const files = fs.readdirSync(MIGRATIONS).sort(compareMigrationFilenames);
      const positions = OWN_MIGRATIONS.map((name) =>
        files.findIndex((f) => f.endsWith(`_${name}.sql`)),
      );
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect(positions[0]).toBeLessThan(positions[1]);
      // the two of the parser-draft work come after the three that built the feature
      expect(positions[3]).toBeGreaterThan(positions[2]);
      expect(positions[4]).toBeGreaterThan(positions[3]);
      // the two of the profile work come last
      expect(positions[5]).toBeGreaterThan(positions[4]);
      expect(positions[6]).toBeGreaterThan(positions[5]);
      // the linked receipts come after the profile work
      expect(positions[7]).toBeGreaterThan(positions[6]);
    });

    it("has the new columns, with the same types, after the replays", async () => {
      const columns = (ds: DataSource) =>
        ds.query(
          `SELECT table_name, column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE (table_name = 'email_receipts'
                   AND column_name IN ('body_html', 'forwarded_by', 'original_sent_at', 'link_key'))
               OR (table_name = 'ai_review_requests'
                   AND column_name IN ('transaction_id', 'email_receipt_ids', 'parser_domain'))
               OR (table_name = 'email_receipt_mailboxes'
                   AND column_name = 'profile_proposals_count_toward_ai_limit')
            ORDER BY 1, 2`,
        );
      const expected = await columns(db);
      expect(expected).toHaveLength(8);
      expect(await columns(upgraded)).toEqual(expected);
    });
  });
});

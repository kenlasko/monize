import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { PayeeAutoMergeService } from "@/payees/payee-auto-merge.service";
import { PayeesModule } from "@/payees/payees.module";
import { PayeesService } from "@/payees/payees.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * A payee merge moves every reference to the payee it deletes (#2026).
 *
 * Warranties, email receipt parsers, a loan's overpayment payee and a
 * shared-expense person all point at payees with `ON DELETE SET NULL`. Both
 * merges used to move only transactions, scheduled transactions and aliases, so
 * the delete of the source payee silently cleared the rest. What a mocked
 * manager cannot show and this does: that the foreign keys are what clear a
 * reference left behind, that each move is visible to the runtime role under
 * RLS, and that nothing is left pointing at a payee that no longer exists.
 * `payee-references.spec.ts` holds the list of columns against `schema.sql`.
 */
describe("Payee merge moves every payee reference (integration)", () => {
  jest.setTimeout(240000);

  let harness: EnforcedIntegrationHarness;
  /** The table owner: seeds and inspects. Never the connection under test. */
  let db: DataSource;
  let payees: PayeesService;
  let autoMerge: PayeeAutoMergeService;
  let userId: string;

  const query = <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => db.query(sql, params) as Promise<T[]>;

  async function seedPayee(name: string): Promise<string> {
    const [row] = await query<{ id: string }>(
      `INSERT INTO payees (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, name],
    );
    return row.id;
  }

  /** One row in each SET NULL table, all pointing at `payeeId`. */
  async function seedReferences(payeeId: string) {
    const [warranty] = await query<{ id: string }>(
      `INSERT INTO warranties (user_id, name, purchase_date, expires_on, payee_id)
       VALUES ($1, 'Television', '2026-10-01', '2028-10-01', $2) RETURNING id`,
      [userId, payeeId],
    );
    const [parser] = await query<{ id: string; revision: number }>(
      `INSERT INTO email_receipt_parsers (user_id, name, payee_id)
       VALUES ($1, 'Receipts', $2) RETURNING id, revision`,
      [userId, payeeId],
    );
    const [loan] = await query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance, overpayment_payee_id)
       VALUES ($1, 'Car loan', 'LOAN', 'USD', 0, 0, $2) RETURNING id`,
      [userId, payeeId],
    );
    const [person] = await query<{ id: string }>(
      `INSERT INTO shared_people (user_id, name, payee_id)
       VALUES ($1, 'Sam', $2) RETURNING id`,
      [userId, payeeId],
    );
    return { warranty, parser, loan, person };
  }

  async function referencesOf(
    refs: Awaited<ReturnType<typeof seedReferences>>,
  ) {
    const [warranty] = await query<{ payee_id: string | null }>(
      `SELECT payee_id FROM warranties WHERE id = $1`,
      [refs.warranty.id],
    );
    const [parser] = await query<{
      payee_id: string | null;
      revision: number;
    }>(`SELECT payee_id, revision FROM email_receipt_parsers WHERE id = $1`, [
      refs.parser.id,
    ]);
    const [loan] = await query<{ overpayment_payee_id: string | null }>(
      `SELECT overpayment_payee_id FROM accounts WHERE id = $1`,
      [refs.loan.id],
    );
    const [person] = await query<{ payee_id: string | null }>(
      `SELECT payee_id FROM shared_people WHERE id = $1`,
      [refs.person.id],
    );
    return {
      warranty: warranty.payee_id,
      parser: parser.payee_id,
      parserRevision: parser.revision,
      loan: loan.overpayment_payee_id,
      person: person.payee_id,
    };
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([PayeesModule]);
    db = harness.owner;
    payees = harness.module.get(PayeesService);
    autoMerge = harness.module.get(PayeeAutoMergeService);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    if (harness) await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "shared_people",
      "email_receipt_parsers",
      "warranties",
      "accounts",
      "payee_aliases",
      "payees",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
  });

  it("the Merge dialog points them all at the target payee", async () => {
    const target = await seedPayee("Costco");
    const source = await seedPayee("Costco Wholesale");
    const refs = await seedReferences(source);

    await withUserContext(userId, () =>
      payees.mergePayees(userId, {
        targetPayeeId: target,
        sourcePayeeId: source,
        addAsAlias: false,
      }),
    );

    expect(await referencesOf(refs)).toEqual({
      warranty: target,
      parser: target,
      parserRevision: refs.parser.revision + 1,
      loan: target,
      person: target,
    });
    const [{ n }] = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM payees WHERE id = $1`,
      [source],
    );
    expect(Number(n)).toBe(0);
  });

  it("Auto-Merge points them all at the canonical payee", async () => {
    const canonical = await seedPayee("Costco");
    const source = await seedPayee("COSTCO WHOLESALE #123");
    const refs = await seedReferences(source);

    const result = await withUserContext(userId, () =>
      autoMerge.applyAutoMerge(userId, [
        { canonicalPayeeId: canonical, sourcePayeeIds: [source] },
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.payeesMerged).toBe(1);
    expect(await referencesOf(refs)).toEqual({
      warranty: canonical,
      parser: canonical,
      parserRevision: refs.parser.revision + 1,
      loan: canonical,
      person: canonical,
    });
  });

  it("leaves another payee's references where they are", async () => {
    const target = await seedPayee("Costco");
    const source = await seedPayee("Costco Wholesale");
    const bystander = await seedPayee("Walmart");
    const refs = await seedReferences(bystander);

    await withUserContext(userId, () =>
      payees.mergePayees(userId, {
        targetPayeeId: target,
        sourcePayeeId: source,
        addAsAlias: false,
      }),
    );

    expect(await referencesOf(refs)).toEqual({
      warranty: bystander,
      parser: bystander,
      parserRevision: refs.parser.revision,
      loan: bystander,
      person: bystander,
    });
  });
});

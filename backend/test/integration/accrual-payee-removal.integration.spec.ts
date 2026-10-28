import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { randomUUID } from "node:crypto";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { createTestUserDirect } from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";

describe("reviewed payee deletion with surviving accruals", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
  });
  beforeEach(async () => {
    await f.reset();
  });
  afterAll(async () => {
    if (f) await f.close();
  });
  const preview = () => f.as(() => f.payees.previewRemoval(f.user, f.payee));
  const remove = (token?: string) =>
    f.as(() => f.payees.remove(f.user, f.payee, token));
  const payeeRow = () =>
    f.h.owner.query("SELECT id,name FROM payees WHERE id=$1", [f.payee]);
  it("reviews and clears payee references while preserving exact ordinary and split schedules", async () => {
    const a = await f.source(),
      cash = await f.source(),
      split = await f.source({ splitCategories: [f.root, f.other] });
    await f.accrue(a.tx.id);
    await f.accrue(split.tx.id, split.lines[0].id);
    const scheduled = await f.scheduled(),
      before = [await f.states(a.tx.id), await f.states(split.tx.id)],
      balance = await f.bank();
    await f.h.owner.query(
      "INSERT INTO payee_aliases(id,user_id,payee_id,alias) VALUES($1,$2,$3,'Tax office alias')",
      [randomUUID(), f.user, f.payee],
    );
    const p = await preview();
    expect(p.transactionIds.sort()).toEqual(
      [a.tx.id, cash.tx.id, split.tx.id].sort(),
    );
    expect(p.scheduledReferences).toBe(1);
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    expect(await payeeRow()).toHaveLength(1);
    await remove(p.fingerprint!);
    await settlePendingHistoryWrites();
    expect(
      (
        await f.h.owner.query(
          "SELECT before_data FROM action_history WHERE user_id=$1 AND entity_id=$2 AND entity_type='accrual_relationship_operation' AND action='update'",
          [f.user, f.payee],
        )
      )[0].before_data.taxonomyOperation.payees[0].id,
    ).toBe(f.payee);
    expect(await payeeRow()).toEqual([]);
    for (const [index, tx] of [a, split].entries()) {
      const after = (await f.states(tx.tx.id))[0],
        prior = before[index][0];
      expect(after).toMatchObject({
        id: prior.id,
        revision: prior.revision + 1,
        family: prior.family,
        allocations: prior.allocations,
      });
      expect(after.fingerprint).not.toBe(prior.fingerprint);
    }
    expect(
      (
        await f.h.owner.query(
          "SELECT payee_id FROM transactions WHERE id=ANY($1::uuid[])",
          [[a.tx.id, cash.tx.id, split.tx.id]],
        )
      ).every((row: { payee_id: string | null }) => row.payee_id === null),
    ).toBe(true);
    expect(
      (
        await f.h.owner.query(
          "SELECT payee_id FROM scheduled_transactions WHERE id=$1",
          [scheduled.id],
        )
      )[0].payee_id,
    ).toBeNull();
    expect(
      await f.h.owner.query("SELECT id FROM payee_aliases WHERE payee_id=$1", [
        f.payee,
      ]),
    ).toEqual([]);
    expect(await f.bank()).toBe(balance);
  });
  it("refuses stale cash, payee and scheduled snapshots before deletion", async () => {
    const a = await f.source(),
      cash = await f.source();
    await f.accrue(a.tx.id);
    const scheduled = await f.scheduled();
    let p = await preview();
    await f.h.owner.query(
      "UPDATE transactions SET description='changed cash' WHERE id=$1",
      [cash.tx.id],
    );
    await expect(remove(p.fingerprint!)).rejects.toMatchObject({ status: 409 });
    p = await preview();
    await f.h.owner.query(
      "UPDATE scheduled_transactions SET name='changed schedule' WHERE id=$1",
      [scheduled.id],
    );
    await expect(remove(p.fingerprint!)).rejects.toMatchObject({ status: 409 });
    p = await preview();
    await f.h.owner.query(
      "UPDATE payees SET notes='changed payee' WHERE id=$1",
      [f.payee],
    );
    await expect(remove(p.fingerprint!)).rejects.toMatchObject({ status: 409 });
    expect(await payeeRow()).toHaveLength(1);
  });
  it("restores the payee, aliases, references and exact schedules if refresh after deletion fails", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const scheduled = await f.scheduled();
    const before = await f.states(a.tx.id),
      balance = await f.bank(),
      alias = randomUUID();
    await f.h.owner.query(
      "INSERT INTO payee_aliases(id,user_id,payee_id,alias) VALUES($1,$2,$3,'Rollback alias')",
      [alias, f.user, f.payee],
    );
    const p = await preview();
    await f.h.owner
      .query(`CREATE FUNCTION reject_payee_deletion_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'required deletion refresh failure'; END $$`);
    await f.h.owner.query(
      "CREATE TRIGGER reject_payee_deletion_refresh BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_payee_deletion_refresh()",
    );
    try {
      await expect(remove(p.fingerprint!)).rejects.toThrow();
      expect(await payeeRow()).toHaveLength(1);
      expect(await f.states(a.tx.id)).toEqual(before);
      expect(
        (
          await f.h.owner.query(
            "SELECT payee_id FROM transactions WHERE id=$1",
            [a.tx.id],
          )
        )[0].payee_id,
      ).toBe(f.payee);
      expect(
        (
          await f.h.owner.query(
            "SELECT payee_id FROM scheduled_transactions WHERE id=$1",
            [scheduled.id],
          )
        )[0].payee_id,
      ).toBe(f.payee);
      expect(
        await f.h.owner.query("SELECT id FROM payee_aliases WHERE id=$1", [
          alias,
        ]),
      ).toHaveLength(1);
      expect(await f.bank()).toBe(balance);
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER reject_payee_deletion_refresh ON accrual_schedules",
      );
      await f.h.owner.query("DROP FUNCTION reject_payee_deletion_refresh()");
    }
  });
  it("supports cash-only deletion without a token and preserves stored payee labels", async () => {
    const a = await f.source({ payeeName: "Original label" }),
      scheduled = await f.scheduled(),
      balance = await f.bank();
    expect((await preview()).fingerprint).toBeNull();
    await remove();
    expect(
      (
        await f.h.owner.query(
          "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
          [a.tx.id],
        )
      )[0],
    ).toEqual({ payee_id: null, payee_name: "Original label" });
    expect(
      (
        await f.h.owner.query(
          "SELECT payee_id FROM scheduled_transactions WHERE id=$1",
          [scheduled.id],
        )
      )[0].payee_id,
    ).toBeNull();
    expect(await f.bank()).toBe(balance);
  });
  it("checks reconciliation and ownership before clearing any references", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    await f.as(() =>
      f.transactions.updateStatus(
        f.user,
        a.tx.id,
        TransactionStatus.RECONCILED,
      ),
    );
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [f.user],
    );
    await expect(preview()).rejects.toMatchObject({ status: 409 });
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    const outsider = (await createTestUserDirect(f.h.owner)).id;
    await expect(
      withUserContext(outsider, () => f.payees.remove(outsider, f.payee)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await payeeRow()).toHaveLength(1);
  });
  it("serializes competing reviewed deletions with one deletion and one refusal", async () => {
    const a = await f.source();
    await f.accrue(a.tx.id);
    const p = await preview(),
      balance = await f.bank();
    const results = await Promise.allSettled([
      remove(p.fingerprint!),
      remove(p.fingerprint!),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await payeeRow()).toEqual([]);
    expect(await f.states(a.tx.id)).toHaveLength(1);
    expect(await f.bank()).toBe(balance);
  });
});

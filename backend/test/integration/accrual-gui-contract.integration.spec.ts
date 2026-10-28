import { createTestAccount } from "../helpers/test-factories";
import { AccrualSourcesDto } from "@/accruals/dto/accrual-sources.dto";
import { validate } from "class-validator";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestUserDirect } from "../helpers/integration-setup";
import { UsersModule } from "@/users/users.module";
import { UsersService } from "@/users/users.service";
import { UpdatePreferencesDto } from "@/users/dto/update-preferences.dto";

describe("Accrual GUI source lookup and preference contract under enforced RLS", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([UsersModule]);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  it("discovers only the selected owned source component schedules with exact month metadata", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    expect(await f.as(() => f.accruals.sourceSchedules(f.user, tx.id))).toEqual(
      [],
    );
    await f.accrue(tx.id, lines[0].id);
    const rows = await f.as(() => f.accruals.sourceSchedules(f.user, tx.id));
    expect(rows).toEqual([
      expect.objectContaining({
        sourceSplitId: lines[0].id,
        preset: "NTM",
        startMonth: "2026-06",
        monthCount: 12,
        revision: 1,
        family: "expense",
      }),
    ]);
    const detail = await f.as(() => f.accruals.detail(f.user, rows[0].id));
    expect(detail.source.splitId).toBe(lines[0].id);
    expect(detail.plan.allocations).toHaveLength(12);
    // VOID source identity stays readable so an existing schedule remains removable.
    await f.h.owner.query("UPDATE transactions SET status='VOID' WHERE id=$1", [
      tx.id,
    ]);
    expect(
      await f.as(() => f.accruals.sourceSchedules(f.user, tx.id)),
    ).toHaveLength(1);
  });
  it("refuses foreign sources and a mismatched effective identity even when no schedules exist", async () => {
    const { tx } = await f.source();
    const foreign = await createTestUserDirect(f.h.owner);
    await expect(
      f.as(() => f.accruals.sourceSchedules(foreign.id, tx.id)),
    ).rejects.toMatchObject({ status: 403 });
    const account = await createTestAccount(f.h.owner, foreign.id);
    const [foreignSource] = await f.h.owner.query(
      "INSERT INTO transactions(user_id,account_id,transaction_date,amount,currency_code) VALUES($1,$2,'2026-06-01',-1,'USD') RETURNING id",
      [foreign.id, account.id],
    );
    await expect(
      f.as(() => f.accruals.sourceSchedules(f.user, foreignSource.id)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("batches owned schedule counts without exposing foreign sources or period rows", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    await f.accrue(tx.id, lines[1].id);
    const foreign = await createTestUserDirect(f.h.owner);
    const account = await createTestAccount(f.h.owner, foreign.id);
    const [other] = await f.h.owner.query(
      "INSERT INTO transactions(user_id,account_id,transaction_date,amount,currency_code) VALUES($1,$2,'2026-06-01',-1,'USD') RETURNING id",
      [foreign.id, account.id],
    );
    expect(
      await f.as(() => f.accruals.sources(f.user, [tx.id, other.id])),
    ).toEqual([{ sourceTransactionId: tx.id, scheduleCount: 2 }]);
    await expect(
      f.as(() => f.accruals.sources(foreign.id, [tx.id])),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("bounds source discovery to unique UUIDs in batches of 100", async () => {
    for (const sourceTransactionIds of [
      [],
      Array(101).fill(f.user),
      [f.user, f.user],
      ["invalid"],
      null,
    ]) {
      expect(
        (
          await validate(
            Object.assign(new AccrualSourcesDto(), { sourceTransactionIds }),
          )
        ).length,
      ).toBeGreaterThan(0);
    }
    expect(
      await validate(
        Object.assign(new AccrualSourcesDto(), {
          sourceTransactionIds: [f.user],
        }),
      ),
    ).toEqual([]);
  });
  it("persists the one reporting default without overwriting unrelated preferences and rejects invalid enums/null", async () => {
    const service = f.h.module.get(UsersService);
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,theme,reporting_basis) VALUES($1,'dark','accrual') ON CONFLICT(user_id) DO UPDATE SET theme='dark',reporting_basis='accrual'",
      [f.user],
    );
    const cash = await f.as(() =>
      service.updatePreferences(
        f.user,
        Object.assign(new UpdatePreferencesDto(), { reportingBasis: "cash" }),
      ),
    );
    expect(cash).toMatchObject({ reportingBasis: "cash", theme: "dark" });
    const accrual = await f.as(() =>
      service.updatePreferences(
        f.user,
        Object.assign(new UpdatePreferencesDto(), {
          reportingBasis: "accrual",
        }),
      ),
    );
    expect(accrual).toMatchObject({ reportingBasis: "accrual", theme: "dark" });
    for (const reportingBasis of ["other", null, ["cash", "accrual"]]) {
      const errors = await validate(
        Object.assign(new UpdatePreferencesDto(), { reportingBasis }),
      );
      expect(errors.some((error) => error.property === "reportingBasis")).toBe(
        true,
      );
    }
  });
});

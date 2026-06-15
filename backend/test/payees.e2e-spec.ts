import { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createTestApp, closeTestApp } from "./helpers/test-database";
import {
  createTestUser,
  createTestAccount,
  createTestCategory,
  createTestPayee,
  buildTransaction,
} from "./helpers/test-factories";
import { PayeesModule } from "@/payees/payees.module";
import { PayeesService } from "@/payees/payees.service";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { Payee } from "@/payees/entities/payee.entity";
import { User } from "@/users/entities/user.entity";

describe("Payee default category repro (e2e)", () => {
  let app: INestApplication;
  let ds: DataSource;
  let service: PayeesService;
  let userId: string;
  let accountId: string;
  let catA: string;
  let catB: string;

  beforeAll(async () => {
    const ctx = await createTestApp([PayeesModule]);
    app = ctx.app;
    ds = ctx.module.get(DataSource);
    service = ctx.module.get(PayeesService);

    const user = await createTestUser(ds.getRepository(User));
    userId = user.id;
    const account = await createTestAccount(ds, userId);
    accountId = account.id;
    catA = (await createTestCategory(ds, userId, { name: "Cat A" })).id;
    catB = (await createTestCategory(ds, userId, { name: "Cat B" })).id;
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  async function seedPayeeWithTransactions() {
    const payee = await createTestPayee(ds, userId, {
      name: `P-${Math.random()}`,
    });
    // 2 uncategorized, 1 already categorized (catA)
    await ds.manager.save(
      ds.manager.create(Transaction, {
        ...buildTransaction(userId, accountId),
        payeeId: payee.id,
        payeeName: payee.name,
        categoryId: null,
      } as any),
    );
    await ds.manager.save(
      ds.manager.create(Transaction, {
        ...buildTransaction(userId, accountId),
        payeeId: payee.id,
        payeeName: payee.name,
        categoryId: null,
      } as any),
    );
    await ds.manager.save(
      ds.manager.create(Transaction, {
        ...buildTransaction(userId, accountId),
        payeeId: payee.id,
        payeeName: payee.name,
        categoryId: catA,
      } as any),
    );
    return payee;
  }

  it("keeps the default category on an unchanged re-save", async () => {
    const payee = await seedPayeeWithTransactions();
    // First set the default category.
    await service.update(userId, payee.id, { defaultCategoryId: catB });
    let row = await ds
      .getRepository(Payee)
      .findOne({ where: { id: payee.id } });
    expect(row?.defaultCategoryId).toBe(catB);

    // A "no change" update (the frontend resends the same category) must not
    // wipe it. Regression: save() on the loaded entity derived the FK from the
    // hydrated defaultCategory relation and nulled the column.
    await service.update(userId, payee.id, { defaultCategoryId: catB });
    row = await ds.getRepository(Payee).findOne({ where: { id: payee.id } });
    expect(row?.defaultCategoryId).toBe(catB);
  });

  it("applies the default category to all of a payee's transactions", async () => {
    const payee = await seedPayeeWithTransactions();
    const result = await service.update(userId, payee.id, {
      defaultCategoryId: catB,
      applyCategoryToTransactions: "all",
    });
    expect(result.transactionsCategorized).toBe(3);
    const txns = await ds
      .getRepository(Transaction)
      .find({ where: { payeeId: payee.id } });
    expect(txns.filter((t) => t.categoryId === catB)).toHaveLength(3);
  });

  it("applies the default category only to uncategorized transactions", async () => {
    const payee = await seedPayeeWithTransactions();
    const result = await service.update(userId, payee.id, {
      defaultCategoryId: catB,
      applyCategoryToTransactions: "uncategorized",
    });
    expect(result.transactionsCategorized).toBe(2);
    const txns = await ds
      .getRepository(Transaction)
      .find({ where: { payeeId: payee.id } });
    // The two uncategorized rows now carry catB; the catA row is untouched.
    expect(txns.filter((t) => t.categoryId === catB)).toHaveLength(2);
    expect(txns.filter((t) => t.categoryId === catA)).toHaveLength(1);
  });
});

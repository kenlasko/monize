import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CategoriesModule } from "@/categories/categories.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { CategoriesService } from "@/categories/categories.service";
import { Category } from "@/categories/entities/category.entity";
import { Payee } from "@/payees/entities/payee.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestCategory } from "../helpers/test-factories";

// Regression: CategoriesService.update/remove were converted to run inside a
// QueryRunner transaction. The service's findOne returns a PLAIN OBJECT
// (`{ ...category, effectiveColor }`), not a Category instance, so
// `queryRunner.manager.save(category)` / `.remove(category)` threw
//   CannotDetermineEntityError: Cannot save/remove, given value must be an
//   instance of entity class ...
// against real TypeORM (the unit-test mocks hid it). The fix passes the
// explicit entity target: `manager.save(Category, ...)` / `.remove(Category, ...)`.
// These tests exercise the service directly so the real persistence path is
// covered.
describe("CategoriesService write paths (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: CategoriesService;

  beforeAll(async () => {
    // TransactionsModule is included so the harness can resolve (and mock)
    // NetWorthService, matching the sibling category-delete integration test.
    module = await createIntegrationModule([
      CategoriesModule,
      TransactionsModule,
    ]);
    dataSource = module.get(DataSource);
    service = module.get(CategoriesService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "categories",
      "payees",
      "users",
    ]);
  });

  it("updates a category and cascades the isIncome change to descendants", async () => {
    const user = await createTestUserDirect(dataSource);
    const parent = await createTestCategory(dataSource, user.id, {
      name: "Parent",
      isIncome: false,
    });
    const child = await createTestCategory(dataSource, user.id, {
      name: "Child",
      isIncome: false,
      parentId: parent.id,
    });

    const updated = await service.update(user.id, parent.id, {
      name: "Parent Renamed",
      isIncome: true,
    });

    expect(updated.name).toBe("Parent Renamed");
    expect(updated.isIncome).toBe(true);

    // The type change must cascade to the descendant within the transaction.
    const reChild = await dataSource.manager.findOneByOrFail(Category, {
      id: child.id,
    });
    expect(reChild.isIncome).toBe(true);
  });

  it("removes a category and clears the default-category reference on payees", async () => {
    const user = await createTestUserDirect(dataSource);
    const category = await createTestCategory(dataSource, user.id, {
      name: "To Delete",
    });
    const payee = await dataSource.manager.save(
      dataSource.manager.create(Payee, {
        userId: user.id,
        name: "Payee With Default",
        defaultCategoryId: category.id,
      }),
    );

    await expect(service.remove(user.id, category.id)).resolves.toBeUndefined();

    // Category gone, and the payee's default reference nulled atomically.
    const reCategory = await dataSource.manager.findOneBy(Category, {
      id: category.id,
    });
    expect(reCategory).toBeNull();

    const rePayee = await dataSource.manager.findOneByOrFail(Payee, {
      id: payee.id,
    });
    expect(rePayee.defaultCategoryId).toBeNull();
  });
});

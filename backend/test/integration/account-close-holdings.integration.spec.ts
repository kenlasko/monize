import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * #2271: an investment account whose Investments page read 0 holdings and
 * 0 cash could not be closed. A sell had left a residue under 0.0001 shares,
 * which the portfolio views do not count as a holding, while the close
 * refused any non-zero quantity. The close now asks the portfolio's own
 * "held" question and names what it refuses over.
 */
describe("Closing an investment account over its holdings (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (
      await createTestAccount(db, userId, {
        name: "Brokerage",
        accountType: "INVESTMENT",
      })
    ).id;
  });

  async function hold(symbol: string, quantity: number) {
    const [{ id }] = await db.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code)
       VALUES ($1, $2, $2, 'STOCK', 'USD') RETURNING id`,
      [userId, symbol],
    );
    await db.query(
      `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
       VALUES ($1, $2, $3, 10)`,
      [accountId, id, quantity],
    );
  }

  const close = () =>
    withUserContext(userId, () => accounts.close(userId, accountId));
  const account = () => db.manager.findOneByOrFail(Account, { id: accountId });

  it("closes over a residue the portfolio does not show as a holding", async () => {
    await hold("DUST", 0.00005);
    await hold("SHORTDUST", -0.00009999);

    await close();

    expect((await account()).isClosed).toBe(true);
  });

  it("refuses while a position the portfolio shows is held, naming it, writing nothing", async () => {
    await hold("DUST", 0.00005);
    await hold("VTI", 0.0001);
    await hold("AAPL", 3);

    const refusal = await close().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as Error).message).toContain("(AAPL, VTI)");
    expect((await account()).isClosed).toBe(false);
  });
});

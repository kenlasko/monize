import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { SeedService } from "./seed.service";
import { User } from "../users/entities/user.entity";

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("$2a$10$hashedpassword"),
}));

describe("SeedService", () => {
  let service: SeedService;
  let dataSource: Record<string, jest.Mock>;
  let usersRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    dataSource = {
      query: jest.fn(),
    };

    usersRepository = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeedService,
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
      ],
    }).compile();

    service = module.get<SeedService>(SeedService);

    // Suppress console.log during tests
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("seedAll()", () => {
    beforeEach(() => {
      // Default mock: demo user doesn't exist yet
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([]);
        }
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: "generated-uuid" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("calls all seed methods in order", async () => {
      await service.seedAll();

      const calls = dataSource.query.mock.calls.map(
        (call: string[]) => call[0],
      );

      // Verify currencies are seeded (INSERT INTO currencies)
      const currencyInserts = calls.filter((sql: string) =>
        sql.includes("INSERT INTO currencies"),
      );
      expect(currencyInserts.length).toBe(10);

      // Verify demo user check
      const userSelect = calls.filter((sql: string) =>
        sql.includes("SELECT id FROM users"),
      );
      expect(userSelect.length).toBe(1);

      // Verify user insert (since user doesn't exist)
      const userInsert = calls.filter((sql: string) =>
        sql.includes("INSERT INTO users"),
      );
      expect(userInsert.length).toBe(1);

      // Verify categories are seeded
      const categoryInserts = calls.filter((sql: string) =>
        sql.includes("INSERT INTO categories"),
      );
      expect(categoryInserts.length).toBeGreaterThan(10);

      // Verify accounts are seeded
      const accountInserts = calls.filter((sql: string) =>
        sql.includes("INSERT INTO accounts"),
      );
      expect(accountInserts.length).toBe(6);

      // Verify transactions are seeded
      const transactionInserts = calls.filter((sql: string) =>
        sql.includes("INSERT INTO transactions"),
      );
      expect(transactionInserts.length).toBe(13);
    });

    it("skips user creation when demo user already exists", async () => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "existing-user-id" }]);
        }
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: "generated-uuid" }]);
        }
        return Promise.resolve([]);
      });

      await service.seedAll();

      const calls = dataSource.query.mock.calls.map(
        (call: string[]) => call[0],
      );

      // User insert should not happen
      const userInsert = calls.filter(
        (sql: string) =>
          sql.includes("INSERT INTO users") &&
          !sql.includes("SELECT"),
      );
      expect(userInsert.length).toBe(0);
    });

    it("seeds 10 currencies with ON CONFLICT DO NOTHING", async () => {
      await service.seedAll();

      const currencyCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO currencies"),
      );

      expect(currencyCalls.length).toBe(10);

      // Verify ON CONFLICT clause
      for (const call of currencyCalls) {
        expect(call[0]).toContain("ON CONFLICT (code) DO NOTHING");
      }

      // Verify specific currencies
      const currencyCodes = currencyCalls.map(
        (call: (string | string[])[]) => (call[1] as string[])[0],
      );
      expect(currencyCodes).toContain("CAD");
      expect(currencyCodes).toContain("USD");
      expect(currencyCodes).toContain("EUR");
      expect(currencyCodes).toContain("GBP");
      expect(currencyCodes).toContain("JPY");
    });

    it("creates demo user with correct email and hashed password", async () => {
      await service.seedAll();

      const userInsertCall = dataSource.query.mock.calls.find(
        (call: string[]) =>
          call[0].includes("INSERT INTO users") &&
          call[0].includes("RETURNING id"),
      );

      expect(userInsertCall).toBeDefined();
      // email
      expect(userInsertCall[1][0]).toBe("demo@monize.com");
      // hashed password
      expect(userInsertCall[1][1]).toBe("$2a$10$hashedpassword");
      // first name
      expect(userInsertCall[1][2]).toBe("Demo");
      // last name
      expect(userInsertCall[1][3]).toBe("User");
      // auth provider
      expect(userInsertCall[1][4]).toBe("local");
    });

    it("seeds income and expense categories with subcategories", async () => {
      await service.seedAll();

      const categoryCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO categories"),
      );

      // 4 income + 12 expense parents + subcategories
      // Total = 4 + 12 + (4+4+3+3+4+4+3+3+5+0+0+0) = 4 + 12 + 33 = 49
      expect(categoryCalls.length).toBeGreaterThanOrEqual(40);
    });

    it("seeds 6 accounts across different types", async () => {
      await service.seedAll();

      const accountCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO accounts"),
      );

      expect(accountCalls.length).toBe(6);
    });

    it("seeds 13 transactions linked to accounts", async () => {
      await service.seedAll();

      const transactionCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO transactions"),
      );

      expect(transactionCalls.length).toBe(13);
    });
  });
});

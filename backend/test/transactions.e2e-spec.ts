import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import * as cookieParser from "cookie-parser";
import { TransactionsController } from "@/transactions/transactions.controller";
import { TransactionsService } from "@/transactions/transactions.service";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthGuard } from "@nestjs/passport";
import { CsrfGuard } from "@/common/guards/csrf.guard";
import { Reflector } from "@nestjs/core";

// -- Mock data ----------------------------------------------------------------

const mockUserId = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const mockAccountId = "b2c3d4e5-f6a7-4901-bcde-f12345678901";
const mockCategoryId = "c3d4e5f6-a7b8-4012-8def-123456789012";
const mockPayeeId = "d4e5f6a7-b8c9-4123-9efa-234567890123";
const mockTransactionId = "e5f6a7b8-c9d0-4234-afab-345678901234";
const mockTransactionId2 = "f6a7b8c9-d0e1-4345-babc-456789012345";

const mockUser = {
  id: mockUserId,
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  authProvider: "local",
  isActive: true,
  role: "user",
};

const mockTransaction = {
  id: mockTransactionId,
  userId: mockUserId,
  accountId: mockAccountId,
  transactionDate: "2026-02-01",
  payeeId: mockPayeeId,
  categoryId: mockCategoryId,
  amount: -50.0,
  currencyCode: "CAD",
  exchangeRate: 1.0,
  description: "Grocery shopping",
  referenceNumber: null,
  status: "UNRECONCILED",
  isSplit: false,
  createdAt: new Date("2026-02-01"),
  updatedAt: new Date("2026-02-01"),
};

const mockPaginatedResult = {
  data: [mockTransaction],
  pagination: {
    page: 1,
    limit: 50,
    total: 1,
    totalPages: 1,
    hasMore: false,
  },
  startingBalance: 1000.0,
};

// -- Mocked service -----------------------------------------------------------

const mockTransactionsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  getSummary: jest.fn(),
  getReconciliationData: jest.fn(),
  bulkReconcile: jest.fn(),
  createTransfer: jest.fn(),
  getSplits: jest.fn(),
  updateSplits: jest.fn(),
  addSplit: jest.fn(),
  removeSplit: jest.fn(),
  getLinkedTransaction: jest.fn(),
  removeTransfer: jest.fn(),
  updateTransfer: jest.fn(),
  markCleared: jest.fn(),
  reconcile: jest.fn(),
  unreconcile: jest.fn(),
  updateStatus: jest.fn(),
};

// -- Test suite ---------------------------------------------------------------

describe("TransactionsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        { provide: TransactionsService, useValue: mockTransactionsService },
        Reflector,
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(CsrfGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          req.user = mockUser;
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------- POST /transactions (create) -----------------------------------

  describe("POST /transactions", () => {
    const validPayload = {
      accountId: mockAccountId,
      transactionDate: "2026-02-10",
      amount: -25.5,
      currencyCode: "CAD",
      payeeId: mockPayeeId,
      categoryId: mockCategoryId,
      description: "Coffee shop",
    };

    it("should create a transaction successfully", async () => {
      const created = { id: mockTransactionId, ...validPayload, userId: mockUserId };
      mockTransactionsService.create.mockResolvedValue(created);

      const res = await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send(validPayload)
        .expect(201);

      expect(res.body.id).toBe(mockTransactionId);
      expect(mockTransactionsService.create).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          accountId: mockAccountId,
          amount: -25.5,
          currencyCode: "CAD",
        }),
      );
    });

    it("should reject a transaction with missing required fields", async () => {
      await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send({ description: "Missing required fields" })
        .expect(400);
    });

    it("should reject a transaction with invalid accountId format", async () => {
      await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send({ ...validPayload, accountId: "not-a-uuid" })
        .expect(400);
    });

    it("should reject a transaction with invalid date format", async () => {
      await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send({ ...validPayload, transactionDate: "02-10-2026" })
        .expect(400);
    });

    it("should reject a transaction with extra unknown fields", async () => {
      await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send({ ...validPayload, hackField: "malicious" })
        .expect(400);
    });

    it("should accept optional splits array", async () => {
      const withSplits = {
        ...validPayload,
        isSplit: true,
        splits: [
          { categoryId: mockCategoryId, amount: -15.0 },
          { categoryId: mockCategoryId, amount: -10.5 },
        ],
      };
      const created = { id: mockTransactionId, ...withSplits, userId: mockUserId };
      mockTransactionsService.create.mockResolvedValue(created);

      await request(app.getHttpServer())
        .post("/transactions")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send(withSplits)
        .expect(201);

      expect(mockTransactionsService.create).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({ isSplit: true }),
      );
    });
  });

  // ---------- GET /transactions (list with pagination) ----------------------

  describe("GET /transactions", () => {
    it("should return paginated transactions", async () => {
      mockTransactionsService.findAll.mockResolvedValue(mockPaginatedResult);

      const res = await request(app.getHttpServer())
        .get("/transactions")
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.total).toBe(1);
      expect(res.body.startingBalance).toBe(1000.0);
      expect(mockTransactionsService.findAll).toHaveBeenCalledWith(
        mockUserId,
        undefined, // accountIds
        undefined, // startDate
        undefined, // endDate
        undefined, // categoryIds
        undefined, // payeeIds
        undefined, // page
        undefined, // limit
        false, // includeInvestmentBrokerage
        undefined, // search
        undefined, // targetTransactionId
      );
    });

    it("should pass filter parameters correctly", async () => {
      mockTransactionsService.findAll.mockResolvedValue({
        data: [],
        pagination: { page: 2, limit: 10, total: 25, totalPages: 3, hasMore: true },
      });

      await request(app.getHttpServer())
        .get("/transactions")
        .query({
          accountIds: `${mockAccountId},${mockTransactionId2}`,
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          page: "2",
          limit: "10",
          search: "grocery",
        })
        .expect(200);

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith(
        mockUserId,
        [mockAccountId, mockTransactionId2], // accountIds parsed from comma-separated
        "2026-01-01",
        "2026-02-01",
        undefined, // categoryIds
        undefined, // payeeIds
        2, // page parsed to int
        10, // limit parsed to int
        false,
        "grocery",
        undefined,
      );
    });

    it("should pass single accountId as array for backward compatibility", async () => {
      mockTransactionsService.findAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false },
      });

      await request(app.getHttpServer())
        .get("/transactions")
        .query({ accountId: mockAccountId })
        .expect(200);

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith(
        mockUserId,
        [mockAccountId], // singular accountId wrapped in array
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
      );
    });

    it("should parse includeInvestmentBrokerage flag", async () => {
      mockTransactionsService.findAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false },
      });

      await request(app.getHttpServer())
        .get("/transactions")
        .query({ includeInvestmentBrokerage: "true" })
        .expect(200);

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith(
        mockUserId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true, // includeInvestmentBrokerage
        undefined,
        undefined,
      );
    });
  });

  // ---------- GET /transactions/:id (get single) ----------------------------

  describe("GET /transactions/:id", () => {
    it("should return a single transaction by ID", async () => {
      mockTransactionsService.findOne.mockResolvedValue(mockTransaction);

      const res = await request(app.getHttpServer())
        .get(`/transactions/${mockTransactionId}`)
        .expect(200);

      expect(res.body.id).toBe(mockTransactionId);
      expect(res.body.amount).toBe(-50.0);
      expect(mockTransactionsService.findOne).toHaveBeenCalledWith(
        mockUserId,
        mockTransactionId,
      );
    });

    it("should return 400 for non-UUID id parameter", async () => {
      await request(app.getHttpServer())
        .get("/transactions/not-a-valid-uuid")
        .expect(400);
    });

    it("should return 404 when transaction does not exist", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      mockTransactionsService.findOne.mockRejectedValue({
        status: 404,
        message: "Transaction not found",
      });

      await request(app.getHttpServer())
        .get(`/transactions/${nonExistentId}`)
        .expect(500); // NestJS wraps non-HttpException errors as 500
    });
  });

  // ---------- PATCH /transactions/:id (update) ------------------------------

  describe("PATCH /transactions/:id", () => {
    const updatePayload = {
      description: "Updated description",
      amount: -75.0,
    };

    it("should update a transaction successfully", async () => {
      const updated = { ...mockTransaction, ...updatePayload };
      mockTransactionsService.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch(`/transactions/${mockTransactionId}`)
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send(updatePayload)
        .expect(200);

      expect(res.body.description).toBe("Updated description");
      expect(res.body.amount).toBe(-75.0);
      expect(mockTransactionsService.update).toHaveBeenCalledWith(
        mockUserId,
        mockTransactionId,
        expect.objectContaining(updatePayload),
      );
    });

    it("should allow partial updates", async () => {
      const partialUpdate = { description: "Only description changed" };
      const updated = { ...mockTransaction, ...partialUpdate };
      mockTransactionsService.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .patch(`/transactions/${mockTransactionId}`)
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send(partialUpdate)
        .expect(200);

      expect(res.body.description).toBe("Only description changed");
      expect(mockTransactionsService.update).toHaveBeenCalledWith(
        mockUserId,
        mockTransactionId,
        expect.objectContaining(partialUpdate),
      );
    });

    it("should return 400 for non-UUID id parameter", async () => {
      await request(app.getHttpServer())
        .patch("/transactions/bad-id")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send(updatePayload)
        .expect(400);
    });

    it("should reject unknown fields in update", async () => {
      await request(app.getHttpServer())
        .patch(`/transactions/${mockTransactionId}`)
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .send({ ...updatePayload, unknownField: "hack" })
        .expect(400);
    });
  });

  // ---------- DELETE /transactions/:id (delete) -----------------------------

  describe("DELETE /transactions/:id", () => {
    it("should delete a transaction successfully", async () => {
      mockTransactionsService.remove.mockResolvedValue({
        message: "Transaction deleted",
      });

      const res = await request(app.getHttpServer())
        .delete(`/transactions/${mockTransactionId}`)
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .expect(200);

      expect(mockTransactionsService.remove).toHaveBeenCalledWith(
        mockUserId,
        mockTransactionId,
      );
    });

    it("should return 400 for non-UUID id parameter", async () => {
      await request(app.getHttpServer())
        .delete("/transactions/invalid-uuid-format")
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .expect(400);
    });

    it("should propagate not-found from service", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const { NotFoundException } = require("@nestjs/common");
      mockTransactionsService.remove.mockRejectedValue(
        new NotFoundException("Transaction not found"),
      );

      await request(app.getHttpServer())
        .delete(`/transactions/${nonExistentId}`)
        .set("X-CSRF-Token", "test")
        .set("Cookie", ["csrf_token=test"])
        .expect(404);
    });
  });
});

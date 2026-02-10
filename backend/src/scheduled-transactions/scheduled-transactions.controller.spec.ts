import { Test, TestingModule } from "@nestjs/testing";
import { ScheduledTransactionsController } from "./scheduled-transactions.controller";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";

describe("ScheduledTransactionsController", () => {
  let controller: ScheduledTransactionsController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findDue: jest.fn(),
      findUpcoming: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      post: jest.fn(),
      skip: jest.fn(),
      findOverrides: jest.fn(),
      hasOverrides: jest.fn(),
      findOverrideByDate: jest.fn(),
      createOverride: jest.fn(),
      findOverride: jest.fn(),
      updateOverride: jest.fn(),
      removeOverride: jest.fn(),
      removeAllOverrides: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScheduledTransactionsController],
      providers: [
        {
          provide: ScheduledTransactionsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<ScheduledTransactionsController>(
      ScheduledTransactionsController,
    );
  });

  describe("create()", () => {
    it("delegates to service.create with userId and dto", async () => {
      const dto = { payeeId: "p1", amount: 100 };
      const expected = { id: "st-1", payeeId: "p1" };
      mockService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to service.findAll with userId", async () => {
      const expected = [{ id: "st-1" }];
      mockService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findAll).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findDue()", () => {
    it("delegates to service.findDue with userId", async () => {
      const expected = [{ id: "st-1", isDue: true }];
      mockService.findDue.mockResolvedValue(expected);

      const result = await controller.findDue(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findDue).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findUpcoming()", () => {
    it("delegates to service.findUpcoming with userId and default days", async () => {
      const expected = [{ id: "st-1" }];
      mockService.findUpcoming.mockResolvedValue(expected);

      const result = await controller.findUpcoming(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 30);
    });

    it("parses days query parameter", async () => {
      mockService.findUpcoming.mockResolvedValue([]);

      await controller.findUpcoming(mockReq, "7");

      expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 7);
    });
  });

  describe("findOne()", () => {
    it("delegates to service.findOne with userId and id", async () => {
      const expected = { id: "st-1", payeeId: "p1" };
      mockService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.findOne).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("update()", () => {
    it("delegates to service.update with userId, id, and dto", async () => {
      const dto = { amount: 200 };
      const expected = { id: "st-1", amount: 200 };
      mockService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "st-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockService.update).toHaveBeenCalledWith("user-1", "st-1", dto);
    });
  });

  describe("remove()", () => {
    it("delegates to service.remove with userId and id", async () => {
      mockService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "st-1");

      expect(result).toBeUndefined();
      expect(mockService.remove).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("post()", () => {
    it("delegates to service.post with userId, id, and dto", async () => {
      const dto = { date: "2024-01-15" };
      const expected = { id: "tx-1", amount: 100 };
      mockService.post.mockResolvedValue(expected);

      const result = await controller.post(mockReq, "st-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockService.post).toHaveBeenCalledWith("user-1", "st-1", dto);
    });
  });

  describe("skip()", () => {
    it("delegates to service.skip with userId and id", async () => {
      const expected = { id: "st-1", nextDueDate: "2024-02-15" };
      mockService.skip.mockResolvedValue(expected);

      const result = await controller.skip(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.skip).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("findOverrides()", () => {
    it("delegates to service.findOverrides with userId and id", async () => {
      const expected = [{ id: "ov-1", date: "2024-03-01" }];
      mockService.findOverrides.mockResolvedValue(expected);

      const result = await controller.findOverrides(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.findOverrides).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("hasOverrides()", () => {
    it("delegates to service.hasOverrides with userId and id", async () => {
      mockService.hasOverrides.mockResolvedValue(true);

      const result = await controller.hasOverrides(mockReq, "st-1");

      expect(result).toBe(true);
      expect(mockService.hasOverrides).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("findOverrideByDate()", () => {
    it("delegates to service.findOverrideByDate with userId, id, and date", async () => {
      const expected = { id: "ov-1", date: "2024-03-01", amount: 150 };
      mockService.findOverrideByDate.mockResolvedValue(expected);

      const result = await controller.findOverrideByDate(
        mockReq,
        "st-1",
        "2024-03-01",
      );

      expect(result).toEqual(expected);
      expect(mockService.findOverrideByDate).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "2024-03-01",
      );
    });
  });

  describe("createOverride()", () => {
    it("delegates to service.createOverride with userId, id, and dto", async () => {
      const dto = { date: "2024-03-01", amount: 150 };
      const expected = { id: "ov-1", ...dto };
      mockService.createOverride.mockResolvedValue(expected);

      const result = await controller.createOverride(
        mockReq,
        "st-1",
        dto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.createOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        dto,
      );
    });
  });

  describe("findOverride()", () => {
    it("delegates to service.findOverride with userId, id, and overrideId", async () => {
      const expected = { id: "ov-1", date: "2024-03-01" };
      mockService.findOverride.mockResolvedValue(expected);

      const result = await controller.findOverride(mockReq, "st-1", "ov-1");

      expect(result).toEqual(expected);
      expect(mockService.findOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
      );
    });
  });

  describe("updateOverride()", () => {
    it("delegates to service.updateOverride with userId, id, overrideId, and dto", async () => {
      const dto = { amount: 200 };
      const expected = { id: "ov-1", amount: 200 };
      mockService.updateOverride.mockResolvedValue(expected);

      const result = await controller.updateOverride(
        mockReq,
        "st-1",
        "ov-1",
        dto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.updateOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
        dto,
      );
    });
  });

  describe("removeOverride()", () => {
    it("delegates to service.removeOverride with userId, id, and overrideId", async () => {
      mockService.removeOverride.mockResolvedValue(undefined);

      const result = await controller.removeOverride(mockReq, "st-1", "ov-1");

      expect(result).toBeUndefined();
      expect(mockService.removeOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
      );
    });
  });

  describe("removeAllOverrides()", () => {
    it("delegates to service.removeAllOverrides with userId and id", async () => {
      mockService.removeAllOverrides.mockResolvedValue(undefined);

      const result = await controller.removeAllOverrides(mockReq, "st-1");

      expect(result).toBeUndefined();
      expect(mockService.removeAllOverrides).toHaveBeenCalledWith(
        "user-1",
        "st-1",
      );
    });
  });
});

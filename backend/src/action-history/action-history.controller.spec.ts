import { Test, TestingModule } from "@nestjs/testing";
import { ActionHistoryController } from "./action-history.controller";
import { ActionHistoryService } from "./action-history.service";

describe("ActionHistoryController", () => {
  let controller: ActionHistoryController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      getHistory: jest.fn(),
      undo: jest.fn(),
      redo: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ActionHistoryController],
      providers: [
        {
          provide: ActionHistoryService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<ActionHistoryController>(ActionHistoryController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("getHistory", () => {
    it("should return action history for the user", async () => {
      const mockHistory = [
        { id: "action-1", description: "Created tag", isUndone: false },
      ];
      mockService.getHistory.mockResolvedValue(mockHistory);

      const result = await controller.getHistory(mockReq, { limit: 50 });

      expect(result).toEqual(mockHistory);
      expect(mockService.getHistory).toHaveBeenCalledWith("user-1", 50);
    });

    it("should use default limit when not provided", async () => {
      mockService.getHistory.mockResolvedValue([]);

      await controller.getHistory(mockReq, {});

      expect(mockService.getHistory).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
    });
  });

  describe("undo", () => {
    it("should call undo on the service", async () => {
      const mockResult = {
        action: { id: "action-1", description: "Created tag" },
        description: "Undone: Created tag",
      };
      mockService.undo.mockResolvedValue(mockResult);

      const result = await controller.undo(mockReq);

      expect(result).toEqual(mockResult);
      expect(mockService.undo).toHaveBeenCalledWith("user-1");
    });
  });

  describe("redo", () => {
    it("should call redo on the service", async () => {
      const mockResult = {
        action: { id: "action-1", description: "Created tag" },
        description: "Redone: Created tag",
      };
      mockService.redo.mockResolvedValue(mockResult);

      const result = await controller.redo(mockReq);

      expect(result).toEqual(mockResult);
      expect(mockService.redo).toHaveBeenCalledWith("user-1");
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { ToursController } from "./tours.controller";
import { ToursService } from "./tours.service";

describe("ToursController", () => {
  let controller: ToursController;
  let mockService: Partial<Record<keyof ToursService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      getProgress: jest.fn(),
      saveProgress: jest.fn(),
      resetProgress: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ToursController],
      providers: [{ provide: ToursService, useValue: mockService }],
    }).compile();

    controller = module.get<ToursController>(ToursController);
  });

  it("getProgress delegates to the service with the request user id", () => {
    mockService.getProgress!.mockReturnValue("progress");
    const result = controller.getProgress(mockReq);
    expect(result).toBe("progress");
    expect(mockService.getProgress).toHaveBeenCalledWith("user-1");
  });

  it("saveProgress passes the user id and dto fields through", () => {
    mockService.saveProgress!.mockReturnValue("saved");
    const result = controller.saveProgress(mockReq, {
      tourId: "intro/basics",
      status: "completed",
    });
    expect(result).toBe("saved");
    expect(mockService.saveProgress).toHaveBeenCalledWith(
      "user-1",
      "intro/basics",
      "completed",
    );
  });

  it("resetProgress delegates to the service with the request user id", () => {
    mockService.resetProgress!.mockReturnValue("reset");
    const result = controller.resetProgress(mockReq);
    expect(result).toBe("reset");
    expect(mockService.resetProgress).toHaveBeenCalledWith("user-1");
  });
});

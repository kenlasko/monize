import { Test, TestingModule } from "@nestjs/testing";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";

describe("UpdatesController", () => {
  let controller: UpdatesController;
  let mockService: Partial<Record<keyof UpdatesService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      getStatus: jest.fn(),
      dismiss: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UpdatesController],
      providers: [
        {
          provide: UpdatesService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get<UpdatesController>(UpdatesController);
  });

  it("getStatus delegates to service with the request user id", () => {
    mockService.getStatus!.mockReturnValue("status");
    const result = controller.getStatus(mockReq);
    expect(result).toBe("status");
    expect(mockService.getStatus).toHaveBeenCalledWith("user-1");
  });

  it("dismiss delegates to service with the request user id", () => {
    mockService.dismiss!.mockReturnValue("dismissed");
    const result = controller.dismiss(mockReq);
    expect(result).toBe("dismissed");
    expect(mockService.dismiss).toHaveBeenCalledWith("user-1");
  });
});

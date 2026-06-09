import { Test, TestingModule } from "@nestjs/testing";
import { InstitutionsController } from "./institutions.controller";
import { InstitutionsService } from "./institutions.service";

describe("InstitutionsController", () => {
  let controller: InstitutionsController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      getLogo: jest.fn(),
      refreshLogo: jest.fn(),
      getAccounts: jest.fn(),
      assignAccount: jest.fn(),
      unassignAccount: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InstitutionsController],
      providers: [{ provide: InstitutionsService, useValue: mockService }],
    }).compile();

    controller = module.get<InstitutionsController>(InstitutionsController);
  });

  it("create() delegates with userId and dto", async () => {
    const dto = { name: "TD", website: "td.com" };
    mockService.create.mockResolvedValue({ id: "inst-1" });
    const result = await controller.create(mockReq, dto as any);
    expect(result).toEqual({ id: "inst-1" });
    expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
  });

  it("findAll() delegates with userId", async () => {
    mockService.findAll.mockResolvedValue([]);
    await controller.findAll(mockReq);
    expect(mockService.findAll).toHaveBeenCalledWith("user-1");
  });

  it("findOne() delegates with userId and id", async () => {
    mockService.findOne.mockResolvedValue({ id: "inst-1" });
    await controller.findOne(mockReq, "inst-1");
    expect(mockService.findOne).toHaveBeenCalledWith("user-1", "inst-1");
  });

  it("getLogo() streams the bytes with content-type and cache headers", async () => {
    const data = Buffer.from([1, 2, 3]);
    mockService.getLogo.mockResolvedValue({ data, contentType: "image/png" });
    const res = { set: jest.fn(), end: jest.fn() };

    await controller.getLogo(mockReq, "inst-1", res as any);

    expect(mockService.getLogo).toHaveBeenCalledWith("user-1", "inst-1");
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "Content-Type": "image/png",
        "Content-Length": "3",
        "Cache-Control": "private, max-age=86400",
      }),
    );
    expect(res.end).toHaveBeenCalledWith(data);
  });

  it("refreshLogo() delegates with userId and id", async () => {
    mockService.refreshLogo.mockResolvedValue({ id: "inst-1" });
    await controller.refreshLogo(mockReq, "inst-1");
    expect(mockService.refreshLogo).toHaveBeenCalledWith("user-1", "inst-1");
  });

  it("getAccounts() delegates with userId and id", async () => {
    mockService.getAccounts.mockResolvedValue([]);
    await controller.getAccounts(mockReq, "inst-1");
    expect(mockService.getAccounts).toHaveBeenCalledWith("user-1", "inst-1");
  });

  it("assignAccount() delegates with userId, id and accountId", async () => {
    mockService.assignAccount.mockResolvedValue({ id: "acc-1" });
    await controller.assignAccount(mockReq, "inst-1", { accountId: "acc-1" });
    expect(mockService.assignAccount).toHaveBeenCalledWith(
      "user-1",
      "inst-1",
      "acc-1",
    );
  });

  it("unassignAccount() delegates with userId, id and accountId", async () => {
    mockService.unassignAccount.mockResolvedValue({ id: "acc-1" });
    await controller.unassignAccount(mockReq, "inst-1", "acc-1");
    expect(mockService.unassignAccount).toHaveBeenCalledWith(
      "user-1",
      "inst-1",
      "acc-1",
    );
  });

  it("update() delegates with userId, id and dto", async () => {
    const dto = { name: "New Name" };
    mockService.update.mockResolvedValue({ id: "inst-1" });
    await controller.update(mockReq, "inst-1", dto as any);
    expect(mockService.update).toHaveBeenCalledWith("user-1", "inst-1", dto);
  });

  it("remove() delegates with userId and id", async () => {
    mockService.remove.mockResolvedValue(undefined);
    await controller.remove(mockReq, "inst-1");
    expect(mockService.remove).toHaveBeenCalledWith("user-1", "inst-1");
  });
});

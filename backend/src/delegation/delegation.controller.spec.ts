import { Test, TestingModule } from "@nestjs/testing";
import { DelegationController } from "./delegation.controller";
import { DelegationService } from "./delegation.service";

describe("DelegationController", () => {
  let controller: DelegationController;
  let service: Record<string, jest.Mock>;
  const req = { user: { id: "owner-1" } };

  beforeEach(async () => {
    service = {
      listDelegates: jest.fn().mockResolvedValue(["d"]),
      createDelegate: jest.fn().mockResolvedValue({ id: "g1" }),
      revokeDelegate: jest.fn().mockResolvedValue(undefined),
      setGrants: jest.fn().mockResolvedValue(undefined),
      setCapabilities: jest.fn().mockResolvedValue(undefined),
      setSectionGrants: jest.fn().mockResolvedValue(undefined),
      resetDelegatePassword: jest
        .fn()
        .mockResolvedValue({ temporaryPassword: "x" }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DelegationController],
      providers: [{ provide: DelegationService, useValue: service }],
    }).compile();

    controller = module.get<DelegationController>(DelegationController);
  });

  it("lists delegates for the current owner", async () => {
    await expect(controller.listDelegates(req)).resolves.toEqual(["d"]);
    expect(service.listDelegates).toHaveBeenCalledWith("owner-1");
  });

  it("creates a delegate", async () => {
    const dto = { email: "a@b.c" } as never;
    await controller.createDelegate(req, dto);
    expect(service.createDelegate).toHaveBeenCalledWith("owner-1", dto);
  });

  it("revokes a delegate", async () => {
    await controller.revokeDelegate(req, "g1");
    expect(service.revokeDelegate).toHaveBeenCalledWith("owner-1", "g1");
  });

  it("sets grants", async () => {
    const grants = [{ accountId: "a1", canRead: true, canCreate: true }];
    await controller.setGrants(req, "g1", { grants } as never);
    expect(service.setGrants).toHaveBeenCalledWith("owner-1", "g1", grants);
  });

  it("sets capabilities", async () => {
    const dto = { canManagePayees: true };
    await controller.setCapabilities(req, "g1", dto as never);
    expect(service.setCapabilities).toHaveBeenCalledWith("owner-1", "g1", dto);
  });

  it("sets section grants", async () => {
    const dto = { billsCanRead: true };
    await controller.setSectionGrants(req, "g1", dto as never);
    expect(service.setSectionGrants).toHaveBeenCalledWith("owner-1", "g1", dto);
  });

  it("resets a delegate password", async () => {
    await expect(controller.resetPassword(req, "g1")).resolves.toEqual({
      temporaryPassword: "x",
    });
    expect(service.resetDelegatePassword).toHaveBeenCalledWith("owner-1", "g1");
  });
});

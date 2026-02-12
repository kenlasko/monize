import { Test, TestingModule } from "@nestjs/testing";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

describe("AdminController", () => {
  let controller: AdminController;
  let mockAdminService: Partial<Record<keyof AdminService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockAdminService = {
      findAllUsers: jest.fn(),
      updateUserRole: jest.fn(),
      updateUserStatus: jest.fn(),
      deleteUser: jest.fn(),
      resetUserPassword: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: AdminService,
          useValue: mockAdminService,
        },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
  });

  describe("findAll()", () => {
    it("delegates to adminService.findAllUsers with no arguments", () => {
      mockAdminService.findAllUsers!.mockReturnValue("users");

      const result = controller.findAll();

      expect(result).toBe("users");
      expect(mockAdminService.findAllUsers).toHaveBeenCalledWith();
    });
  });

  describe("updateRole()", () => {
    it("delegates to adminService.updateUserRole with adminId, userId, and role", () => {
      const dto = { role: "admin" } as any;
      mockAdminService.updateUserRole!.mockReturnValue("updated");

      const result = controller.updateRole(mockReq, "target-user-1", dto);

      expect(result).toBe("updated");
      expect(mockAdminService.updateUserRole).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
        "admin",
      );
    });
  });

  describe("updateStatus()", () => {
    it("delegates to adminService.updateUserStatus with adminId, userId, and isActive", () => {
      const dto = { isActive: false } as any;
      mockAdminService.updateUserStatus!.mockReturnValue("updated");

      const result = controller.updateStatus(mockReq, "target-user-1", dto);

      expect(result).toBe("updated");
      expect(mockAdminService.updateUserStatus).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
        false,
      );
    });
  });

  describe("deleteUser()", () => {
    it("delegates to adminService.deleteUser with adminId and userId", () => {
      mockAdminService.deleteUser!.mockReturnValue("deleted");

      const result = controller.deleteUser(mockReq, "target-user-1");

      expect(result).toBe("deleted");
      expect(mockAdminService.deleteUser).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });
  });

  describe("resetPassword()", () => {
    it("delegates to adminService.resetUserPassword with adminId and userId", () => {
      mockAdminService.resetUserPassword!.mockReturnValue("reset");

      const result = controller.resetPassword(mockReq, "target-user-1");

      expect(result).toBe("reset");
      expect(mockAdminService.resetUserPassword).toHaveBeenCalledWith(
        "user-1",
        "target-user-1",
      );
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;
  let mockDataSource: Partial<DataSource>;

  beforeEach(async () => {
    mockDataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe("check()", () => {
    it("returns ok status when database is healthy", async () => {
      (mockDataSource.query as jest.Mock).mockResolvedValue([
        { "?column?": 1 },
      ]);

      const result = await controller.check();

      expect(result.status).toBe("ok");
      expect(result.checks.database).toBe("healthy");
      expect(result.timestamp).toBeDefined();
    });

    it("returns degraded status when database is unhealthy", async () => {
      (mockDataSource.query as jest.Mock).mockRejectedValue(
        new Error("connection failed"),
      );

      const result = await controller.check();

      expect(result.status).toBe("degraded");
      expect(result.checks.database).toBe("unhealthy");
    });
  });

  describe("live()", () => {
    it("always returns ok", () => {
      const result = controller.live();
      expect(result).toEqual({ status: "ok" });
    });
  });

  describe("ready()", () => {
    it("returns ok when database is healthy", async () => {
      (mockDataSource.query as jest.Mock).mockResolvedValue([
        { "?column?": 1 },
      ]);

      const result = await controller.ready();
      expect(result).toEqual({ status: "ok" });
    });

    it("throws error when database is unhealthy", async () => {
      (mockDataSource.query as jest.Mock).mockRejectedValue(
        new Error("connection failed"),
      );

      await expect(controller.ready()).rejects.toThrow("Database not ready");
    });
  });
});

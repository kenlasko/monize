import { Test, TestingModule } from "@nestjs/testing";
import { LoanRateChangesController } from "./loan-rate-changes.controller";
import { LoanRateChangesService } from "./loan-rate-changes.service";
import { RateChangeInferenceService } from "./rate-change-inference.service";

describe("LoanRateChangesController", () => {
  let controller: LoanRateChangesController;
  let service: Record<string, jest.Mock>;
  let inferenceService: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };
  const accountId = "account-1";

  beforeEach(async () => {
    service = {
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "rc-1" }),
      update: jest.fn().mockResolvedValue({ id: "rc-1" }),
      remove: jest.fn().mockResolvedValue(undefined),
      applyScheduledPaymentSync: jest.fn().mockResolvedValue(null),
    };
    inferenceService = {
      detectAndPersist: jest
        .fn()
        .mockResolvedValue({ created: [], replacedCount: 0, warnings: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoanRateChangesController],
      providers: [
        { provide: LoanRateChangesService, useValue: service },
        { provide: RateChangeInferenceService, useValue: inferenceService },
      ],
    }).compile();

    controller = module.get<LoanRateChangesController>(
      LoanRateChangesController,
    );
  });

  it("lists rate changes for the requesting user", async () => {
    await controller.findAll(req, accountId);
    expect(service.findAll).toHaveBeenCalledWith("user-1", accountId);
  });

  it("creates a rate change, deferring the scheduled-payment sync for confirmation", async () => {
    const dto = { effectiveDate: "2024-06-01", annualRate: 4.9 };
    await controller.create(req, accountId, dto as any);
    expect(service.create).toHaveBeenCalledWith("user-1", accountId, dto, {
      deferScheduledSync: true,
    });
  });

  it("applies the pending scheduled-payment change", async () => {
    await controller.applyScheduledPayment(req, accountId);
    expect(service.applyScheduledPaymentSync).toHaveBeenCalledWith(
      "user-1",
      accountId,
    );
  });

  it("runs detection", async () => {
    const result = await controller.detect(req, accountId);
    expect(inferenceService.detectAndPersist).toHaveBeenCalledWith(
      "user-1",
      accountId,
    );
    expect(result).toEqual({ created: [], replacedCount: 0, warnings: [] });
  });

  it("updates a rate change", async () => {
    const dto = { annualRate: 5.1 };
    await controller.update(req, accountId, "rc-1", dto as any);
    expect(service.update).toHaveBeenCalledWith(
      "user-1",
      accountId,
      "rc-1",
      dto,
    );
  });

  it("removes a rate change", async () => {
    await controller.remove(req, accountId, "rc-1");
    expect(service.remove).toHaveBeenCalledWith("user-1", accountId, "rc-1");
  });
});

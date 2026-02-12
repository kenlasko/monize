import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";

describe("ScheduledTransactionOverrideService", () => {
  let service: ScheduledTransactionOverrideService;
  let overridesRepository: Record<string, jest.Mock>;

  const scheduledTransactionId = "st-1";
  const overrideId = "override-1";

  const makeOverride = (
    overrides: Partial<ScheduledTransactionOverride> = {},
  ): ScheduledTransactionOverride =>
    ({
      id: overrideId,
      scheduledTransactionId,
      originalDate: "2025-01-15",
      overrideDate: "2025-01-16",
      amount: -100,
      categoryId: "cat-1",
      description: "Override description",
      isSplit: null,
      splits: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as ScheduledTransactionOverride;

  const mockQueryBuilder = (result: any = null) => {
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(result),
    };
    return qb;
  };

  beforeEach(async () => {
    overridesRepository = {
      create: jest.fn().mockImplementation((data: any) => ({
        id: "new-override-id",
        ...data,
      })),
      save: jest.fn().mockImplementation((entity: any) =>
        Promise.resolve(entity),
      ),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      remove: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionOverrideService,
        {
          provide: getRepositoryToken(ScheduledTransactionOverride),
          useValue: overridesRepository,
        },
      ],
    }).compile();

    service = module.get<ScheduledTransactionOverrideService>(
      ScheduledTransactionOverrideService,
    );
  });

  describe("createOverride", () => {
    it("should create an override when no existing override for the date", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-16",
        amount: -150,
        description: "Adjusted payment",
      };

      const result = await service.createOverride(
        scheduledTransactionId,
        dto,
      );

      expect(overridesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledTransactionId,
          originalDate: "2025-02-15",
          overrideDate: "2025-02-16",
          amount: -150,
          description: "Adjusted payment",
        }),
      );
      expect(overridesRepository.save).toHaveBeenCalled();
    });

    it("should throw BadRequestException when override already exists for the date", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(makeOverride()),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-01-15",
        overrideDate: "2025-01-16",
      };

      await expect(
        service.createOverride(scheduledTransactionId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should handle optional fields being null", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
      };

      await service.createOverride(scheduledTransactionId, dto);

      expect(overridesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: null,
          categoryId: null,
          description: null,
          isSplit: null,
          splits: null,
        }),
      );
    });

    it("should validate splits when isSplit is true", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -100,
        isSplit: true,
        splits: [
          { amount: -60, memo: "Part 1" },
          { amount: -40, memo: "Part 2" },
        ],
      };

      const result = await service.createOverride(
        scheduledTransactionId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalled();
    });

    it("should throw BadRequestException when split amounts do not match total", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -100,
        isSplit: true,
        splits: [
          { amount: -50, memo: "Part 1" },
          { amount: -40, memo: "Part 2" },
        ],
      };

      await expect(
        service.createOverride(scheduledTransactionId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when isSplit is true but amount is missing", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        isSplit: true,
        splits: [
          { amount: -60, memo: "Part 1" },
          { amount: -40, memo: "Part 2" },
        ],
      };

      await expect(
        service.createOverride(scheduledTransactionId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when splits have fewer than 2 entries", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -100,
        isSplit: true,
        splits: [{ amount: -100, memo: "Only one" }],
      };

      await expect(
        service.createOverride(scheduledTransactionId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when a split amount is zero", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -100,
        isSplit: true,
        splits: [
          { amount: -100, memo: "Part 1" },
          { amount: 0, memo: "Zero part" },
        ],
      };

      await expect(
        service.createOverride(scheduledTransactionId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should map splits with null categoryId and memo", async () => {
      overridesRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder(null),
      );

      const dto: CreateScheduledTransactionOverrideDto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -100,
        isSplit: true,
        splits: [
          { amount: -60 },
          { amount: -40 },
        ],
      };

      await service.createOverride(scheduledTransactionId, dto);

      expect(overridesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          splits: [
            { categoryId: null, amount: -60, memo: null },
            { categoryId: null, amount: -40, memo: null },
          ],
        }),
      );
    });
  });

  describe("findOverrides", () => {
    it("should return all overrides for a scheduled transaction", async () => {
      const overrides = [
        makeOverride({ id: "o1", originalDate: "2025-01-15" }),
        makeOverride({ id: "o2", originalDate: "2025-02-15" }),
      ];
      overridesRepository.find.mockResolvedValue(overrides);

      const result = await service.findOverrides(scheduledTransactionId);

      expect(result).toHaveLength(2);
      expect(overridesRepository.find).toHaveBeenCalledWith({
        where: { scheduledTransactionId },
        relations: ["category"],
        order: { overrideDate: "ASC" },
      });
    });

    it("should return empty array when no overrides exist", async () => {
      overridesRepository.find.mockResolvedValue([]);

      const result = await service.findOverrides(scheduledTransactionId);

      expect(result).toEqual([]);
    });
  });

  describe("findOverride", () => {
    it("should return the override when found", async () => {
      const override = makeOverride();
      overridesRepository.findOne.mockResolvedValue(override);

      const result = await service.findOverride(
        scheduledTransactionId,
        overrideId,
      );

      expect(result).toEqual(override);
      expect(overridesRepository.findOne).toHaveBeenCalledWith({
        where: { id: overrideId, scheduledTransactionId },
        relations: ["category"],
      });
    });

    it("should throw NotFoundException when override is not found", async () => {
      overridesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOverride(scheduledTransactionId, "non-existent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("findOverrideByDate", () => {
    it("should find an override matching the given date", async () => {
      const override = makeOverride({ originalDate: "2025-01-15" });
      overridesRepository.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        scheduledTransactionId,
        "2025-01-15",
      );

      expect(result).toEqual(override);
    });

    it("should return null when no override matches the date", async () => {
      overridesRepository.find.mockResolvedValue([
        makeOverride({ originalDate: "2025-02-15" }),
      ]);

      const result = await service.findOverrideByDate(
        scheduledTransactionId,
        "2025-01-15",
      );

      expect(result).toBeNull();
    });

    it("should normalize date by stripping time component", async () => {
      const override = makeOverride({ originalDate: "2025-01-15" });
      overridesRepository.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        scheduledTransactionId,
        "2025-01-15T12:00:00Z",
      );

      expect(result).toEqual(override);
    });

    it("should return null when no overrides exist at all", async () => {
      overridesRepository.find.mockResolvedValue([]);

      const result = await service.findOverrideByDate(
        scheduledTransactionId,
        "2025-01-15",
      );

      expect(result).toBeNull();
    });
  });

  describe("updateOverride", () => {
    it("should update override amount", async () => {
      const existing = makeOverride();
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        amount: -200,
      };

      await service.updateOverride(
        scheduledTransactionId,
        overrideId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -200 }),
      );
    });

    it("should update override description", async () => {
      const existing = makeOverride();
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        description: "New description",
      };

      await service.updateOverride(
        scheduledTransactionId,
        overrideId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: "New description" }),
      );
    });

    it("should update override categoryId to null", async () => {
      const existing = makeOverride({ categoryId: "cat-1" });
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        categoryId: null,
      };

      await service.updateOverride(
        scheduledTransactionId,
        overrideId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: null }),
      );
    });

    it("should update override with splits", async () => {
      const existing = makeOverride({ amount: -100 });
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        isSplit: true,
        splits: [
          { amount: -60, categoryId: "cat-a" },
          { amount: -40, categoryId: "cat-b" },
        ],
      };

      await service.updateOverride(
        scheduledTransactionId,
        overrideId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isSplit: true,
          splits: expect.arrayContaining([
            expect.objectContaining({ amount: -60, categoryId: "cat-a" }),
            expect.objectContaining({ amount: -40, categoryId: "cat-b" }),
          ]),
        }),
      );
    });

    it("should validate splits against existing amount when update amount not provided", async () => {
      const existing = makeOverride({ amount: -100 });
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        isSplit: true,
        splits: [
          { amount: -60, memo: "Part 1" },
          { amount: -30, memo: "Part 2" }, // sum = -90, not -100
        ],
      };

      await expect(
        service.updateOverride(scheduledTransactionId, overrideId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when splits with amount null", async () => {
      const existing = makeOverride({ amount: null });
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {
        isSplit: true,
        splits: [
          { amount: -60, memo: "Part 1" },
          { amount: -40, memo: "Part 2" },
        ],
      };

      await expect(
        service.updateOverride(scheduledTransactionId, overrideId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw NotFoundException when override does not exist", async () => {
      overridesRepository.findOne.mockResolvedValue(null);

      const dto: UpdateScheduledTransactionOverrideDto = {
        amount: -200,
      };

      await expect(
        service.updateOverride(scheduledTransactionId, "non-existent", dto),
      ).rejects.toThrow(NotFoundException);
    });

    it("should not change fields when not provided in dto", async () => {
      const existing = makeOverride({
        amount: -100,
        description: "Original",
        categoryId: "cat-1",
      });
      overridesRepository.findOne.mockResolvedValue(existing);

      const dto: UpdateScheduledTransactionOverrideDto = {};

      await service.updateOverride(
        scheduledTransactionId,
        overrideId,
        dto,
      );

      expect(overridesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: -100,
          description: "Original",
          categoryId: "cat-1",
        }),
      );
    });
  });

  describe("removeOverride", () => {
    it("should remove the override when found", async () => {
      const existing = makeOverride();
      overridesRepository.findOne.mockResolvedValue(existing);

      await service.removeOverride(scheduledTransactionId, overrideId);

      expect(overridesRepository.remove).toHaveBeenCalledWith(existing);
    });

    it("should throw NotFoundException when override does not exist", async () => {
      overridesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeOverride(scheduledTransactionId, "non-existent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("removeAllOverrides", () => {
    it("should delete all overrides for a scheduled transaction", async () => {
      overridesRepository.delete.mockResolvedValue({ affected: 3 });

      const count = await service.removeAllOverrides(scheduledTransactionId);

      expect(count).toBe(3);
      expect(overridesRepository.delete).toHaveBeenCalledWith({
        scheduledTransactionId,
      });
    });

    it("should return 0 when no overrides exist", async () => {
      overridesRepository.delete.mockResolvedValue({ affected: 0 });

      const count = await service.removeAllOverrides(scheduledTransactionId);

      expect(count).toBe(0);
    });

    it("should return 0 when affected is undefined", async () => {
      overridesRepository.delete.mockResolvedValue({});

      const count = await service.removeAllOverrides(scheduledTransactionId);

      expect(count).toBe(0);
    });
  });

  describe("hasOverrides", () => {
    it("should return hasOverrides: true with count when overrides exist", async () => {
      overridesRepository.count.mockResolvedValue(5);

      const result = await service.hasOverrides(scheduledTransactionId);

      expect(result).toEqual({ hasOverrides: true, count: 5 });
      expect(overridesRepository.count).toHaveBeenCalledWith({
        where: { scheduledTransactionId },
      });
    });

    it("should return hasOverrides: false with count 0 when no overrides", async () => {
      overridesRepository.count.mockResolvedValue(0);

      const result = await service.hasOverrides(scheduledTransactionId);

      expect(result).toEqual({ hasOverrides: false, count: 0 });
    });
  });
});

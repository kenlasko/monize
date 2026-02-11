import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { CurrenciesService } from "./currencies.service";
import { Currency } from "./entities/currency.entity";

describe("CurrenciesService", () => {
  let service: CurrenciesService;
  let mockRepository: Partial<Record<keyof Repository<Currency>, jest.Mock>>;
  let mockDataSource: { query: jest.Mock };

  const mockCurrency: Currency = {
    code: "CAD",
    name: "Canadian Dollar",
    symbol: "CA$",
    decimalPlaces: 2,
    isActive: true,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    mockRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    mockDataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrenciesService,
        {
          provide: getRepositoryToken(Currency),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<CurrenciesService>(CurrenciesService);
  });

  describe("create()", () => {
    it("creates a new currency successfully", async () => {
      const dto = {
        code: "NZD",
        name: "New Zealand Dollar",
        symbol: "NZ$",
        decimalPlaces: 2,
      };

      mockRepository.findOne!.mockResolvedValue(null);
      mockRepository.create!.mockReturnValue({ ...dto, isActive: true });
      mockRepository.save!.mockResolvedValue({ ...dto, isActive: true });

      const result = await service.create(dto);

      expect(result).toEqual({ ...dto, isActive: true });
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });

    it("throws ConflictException if currency code already exists", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);

      await expect(
        service.create({ code: "CAD", name: "Test", symbol: "$" }),
      ).rejects.toThrow(ConflictException);
    });

    it("uppercases the code", async () => {
      mockRepository.findOne!.mockResolvedValue(null);
      mockRepository.create!.mockReturnValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
      });
      mockRepository.save!.mockResolvedValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
      });

      await service.create({ code: "nzd", name: "Test", symbol: "$" });

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });
  });

  describe("findAll()", () => {
    it("returns only active currencies by default", async () => {
      mockRepository.find!.mockResolvedValue([mockCurrency]);

      const result = await service.findAll();

      expect(result).toEqual([mockCurrency]);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { code: "ASC" },
      });
    });

    it("returns all currencies when includeInactive is true", async () => {
      mockRepository.find!.mockResolvedValue([mockCurrency]);

      await service.findAll(true);

      expect(mockRepository.find).toHaveBeenCalledWith({
        where: {},
        order: { code: "ASC" },
      });
    });
  });

  describe("findOne()", () => {
    it("returns a currency by code", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);

      const result = await service.findOne("CAD");

      expect(result).toEqual(mockCurrency);
    });

    it("throws NotFoundException if currency not found", async () => {
      mockRepository.findOne!.mockResolvedValue(null);

      await expect(service.findOne("XYZ")).rejects.toThrow(NotFoundException);
    });
  });

  describe("update()", () => {
    it("updates and returns the currency", async () => {
      mockRepository.findOne!.mockResolvedValue({ ...mockCurrency });
      mockRepository.save!.mockResolvedValue({
        ...mockCurrency,
        name: "Updated Name",
      });

      const result = await service.update("CAD", { name: "Updated Name" });

      expect(result.name).toBe("Updated Name");
      expect(mockRepository.save).toHaveBeenCalled();
    });
  });

  describe("deactivate()", () => {
    it("sets isActive to false and saves", async () => {
      mockRepository.findOne!.mockResolvedValue({ ...mockCurrency });
      mockRepository.save!.mockImplementation((c) =>
        Promise.resolve({ ...c, isActive: false }),
      );

      const result = await service.deactivate("CAD");

      expect(result.isActive).toBe(false);
    });
  });

  describe("activate()", () => {
    it("sets isActive to true and saves", async () => {
      const inactiveCurrency = { ...mockCurrency, isActive: false };
      mockRepository.findOne!.mockResolvedValue(inactiveCurrency);
      mockRepository.save!.mockImplementation((c) =>
        Promise.resolve({ ...c, isActive: true }),
      );

      const result = await service.activate("CAD");

      expect(result.isActive).toBe(true);
    });
  });

  describe("remove()", () => {
    it("deletes a currency that is not in use", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockRepository.remove!.mockResolvedValue(undefined);

      await service.remove("CAD");

      expect(mockRepository.remove).toHaveBeenCalledWith(mockCurrency);
    });

    it("throws ConflictException if currency is in use", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: true }]);

      await expect(service.remove("CAD")).rejects.toThrow(ConflictException);
    });
  });

  describe("getUsage()", () => {
    it("returns usage counts per currency", async () => {
      mockDataSource.query.mockResolvedValue([
        { code: "CAD", accounts: "3", securities: "5" },
        { code: "USD", accounts: "1", securities: "0" },
      ]);

      const result = await service.getUsage();

      expect(result).toEqual({
        CAD: { accounts: 3, securities: 5 },
        USD: { accounts: 1, securities: 0 },
      });
    });
  });
});

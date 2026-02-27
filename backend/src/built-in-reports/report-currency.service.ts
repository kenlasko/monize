import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

export interface RawCategoryAggregate {
  category_id: string | null;
  currency_code: string;
  total: string;
}

export interface RawPayeeAggregate {
  payee_id: string | null;
  payee_name: string | null;
  currency_code: string;
  total: string;
}

export interface RawMonthlyAggregate {
  month: string;
  currency_code: string;
  income: string;
  expenses: string;
}

export interface RawMonthlyCategoryAggregate {
  month: string;
  category_id: string | null;
  currency_code: string;
  total: string;
}

export type RateMap = Map<string, number>;

@Injectable()
export class ReportCurrencyService {
  private readonly logger = new Logger(ReportCurrencyService.name);

  constructor(
    @InjectRepository(UserPreference)
    private userPreferenceRepository: Repository<UserPreference>,
    private exchangeRateService: ExchangeRateService,
  ) {}

  async getDefaultCurrency(userId: string): Promise<string> {
    const pref = await this.userPreferenceRepository.findOne({
      where: { userId },
    });
    return pref?.defaultCurrency || "USD";
  }

  async buildRateMap(_defaultCurrency: string): Promise<RateMap> {
    const rates = await this.exchangeRateService.getLatestRates();
    const rateMap: RateMap = new Map();
    for (const rate of rates) {
      rateMap.set(
        `${rate.fromCurrency}->${rate.toCurrency}`,
        Number(rate.rate),
      );
    }
    return rateMap;
  }

  convertAmount(
    amount: number,
    fromCurrency: string,
    defaultCurrency: string,
    rateMap: RateMap,
  ): number {
    if (!fromCurrency || fromCurrency === defaultCurrency) return amount;
    const directKey = `${fromCurrency}->${defaultCurrency}`;
    const directRate = rateMap.get(directKey);
    if (directRate) return amount * directRate;
    const inverseKey = `${defaultCurrency}->${fromCurrency}`;
    const inverseRate = rateMap.get(inverseKey);
    if (inverseRate && inverseRate !== 0) return amount / inverseRate;
    // M30: Log warning when no conversion rate is found instead of silently returning unconverted amount
    this.logger.warn(
      `No exchange rate found for ${fromCurrency} -> ${defaultCurrency}, returning unconverted amount`,
    );
    return amount;
  }
}

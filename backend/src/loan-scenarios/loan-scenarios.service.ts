import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { tr } from "../i18n/translate";
import { LoanScenario } from "./entities/loan-scenario.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { CreateLoanScenarioDto } from "./dto/create-loan-scenario.dto";
import { UpdateLoanScenarioDto } from "./dto/update-loan-scenario.dto";

const LOAN_ACCOUNT_TYPES = [
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
];

@Injectable()
export class LoanScenariosService {
  constructor(
    @InjectRepository(LoanScenario)
    private scenariosRepository: Repository<LoanScenario>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
  ) {}

  async findAll(userId: string, accountId: string): Promise<LoanScenario[]> {
    await this.verifyLoanAccount(userId, accountId);
    return this.scenariosRepository.find({
      where: { userId, accountId },
      order: { name: "ASC" },
    });
  }

  async create(
    userId: string,
    accountId: string,
    dto: CreateLoanScenarioDto,
  ): Promise<LoanScenario> {
    await this.verifyLoanAccount(userId, accountId);
    await this.rejectDuplicateName(userId, accountId, dto.name);

    const scenario = this.scenariosRepository.create({
      name: dto.name,
      recurringExtraAmount: dto.recurringExtraAmount ?? null,
      recurringExtraMode: dto.recurringExtraMode ?? null,
      recurringExtraFrequency: dto.recurringExtraFrequency ?? null,
      recurringExtraStartDate: dto.recurringExtraStartDate ?? null,
      recurringExtraEndDate: dto.recurringExtraEndDate ?? null,
      lumpSums: dto.lumpSums ?? [],
      userId,
      accountId,
    });
    return this.scenariosRepository.save(scenario);
  }

  async update(
    userId: string,
    accountId: string,
    id: string,
    dto: UpdateLoanScenarioDto,
  ): Promise<LoanScenario> {
    const scenario = await this.findOne(userId, accountId, id);

    if (dto.name && dto.name.toLowerCase() !== scenario.name.toLowerCase()) {
      await this.rejectDuplicateName(userId, accountId, dto.name);
    }

    const updated = this.scenariosRepository.merge(scenario, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.recurringExtraAmount !== undefined
        ? { recurringExtraAmount: dto.recurringExtraAmount }
        : {}),
      ...(dto.recurringExtraMode !== undefined
        ? { recurringExtraMode: dto.recurringExtraMode }
        : {}),
      ...(dto.recurringExtraFrequency !== undefined
        ? { recurringExtraFrequency: dto.recurringExtraFrequency }
        : {}),
      ...(dto.recurringExtraStartDate !== undefined
        ? { recurringExtraStartDate: dto.recurringExtraStartDate }
        : {}),
      ...(dto.recurringExtraEndDate !== undefined
        ? { recurringExtraEndDate: dto.recurringExtraEndDate }
        : {}),
      ...(dto.lumpSums !== undefined ? { lumpSums: dto.lumpSums } : {}),
    });
    return this.scenariosRepository.save(updated);
  }

  async remove(userId: string, accountId: string, id: string): Promise<void> {
    const scenario = await this.findOne(userId, accountId, id);
    await this.scenariosRepository.remove(scenario);
  }

  private async findOne(
    userId: string,
    accountId: string,
    id: string,
  ): Promise<LoanScenario> {
    const scenario = await this.scenariosRepository.findOne({
      where: { id, userId, accountId },
    });
    if (!scenario) {
      throw new NotFoundException(
        tr(
          "errors.loanScenarios.notFound",
          `Loan scenario with ID ${id} not found`,
          { id },
        ),
      );
    }
    return scenario;
  }

  /** Ownership and type gate applied before any scenario operation */
  private async verifyLoanAccount(
    userId: string,
    accountId: string,
  ): Promise<void> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId, userId },
    });
    if (!account) {
      throw new NotFoundException(
        tr(
          "errors.accounts.accountWithIdNotFound",
          `Account with ID ${accountId} not found`,
          { id: accountId },
        ),
      );
    }
    if (!LOAN_ACCOUNT_TYPES.includes(account.accountType)) {
      throw new BadRequestException(
        tr(
          "errors.loanScenarios.notLoanAccount",
          "Loan scenarios are only available for loan, mortgage, and line of credit accounts",
        ),
      );
    }
  }

  private async rejectDuplicateName(
    userId: string,
    accountId: string,
    name: string,
  ): Promise<void> {
    const existing = await this.scenariosRepository
      .createQueryBuilder("scenario")
      .where("scenario.userId = :userId", { userId })
      .andWhere("scenario.accountId = :accountId", { accountId })
      .andWhere("LOWER(scenario.name) = LOWER(:name)", { name })
      .getOne();
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.loanScenarios.nameConflict",
          `A scenario named "${name}" already exists for this account`,
          { name },
        ),
      );
    }
  }
}

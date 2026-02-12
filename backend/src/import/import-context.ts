import { Account } from "../accounts/entities/account.entity";
import { ImportResultDto } from "./dto/import.dto";

export interface ImportContext {
  queryRunner: any;
  userId: string;
  accountId: string;
  account: Account;
  categoryMap: Map<string, string | null>;
  accountMap: Map<string, string | null>;
  loanCategoryMap: Map<string, string>;
  securityMap: Map<string, string | null>;
  importStartTime: Date;
  dateCounters: Map<string, number>;
  affectedAccountIds: Set<string>;
  importResult: ImportResultDto;
}

/**
 * Update account balance with proper decimal rounding.
 * Uses explicit read-modify-write to avoid TypeORM increment precision issues.
 */
export async function updateAccountBalance(
  queryRunner: any,
  accountId: string,
  amount: number,
): Promise<void> {
  const account = await queryRunner.manager.findOne(Account, {
    where: { id: accountId },
  });
  if (account) {
    const currentBalance = Number(account.currentBalance) || 0;
    const newBalance =
      Math.round((currentBalance + Number(amount)) * 100) / 100;
    await queryRunner.manager.update(Account, accountId, {
      currentBalance: newBalance,
    });
  }
}

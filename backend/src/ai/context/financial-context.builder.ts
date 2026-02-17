import { Injectable } from "@nestjs/common";

/**
 * Part 2: Builds financial context from user data for AI prompts.
 * Will pull categories, recent transactions, payee patterns, etc.
 */
@Injectable()
export class FinancialContextBuilder {
  async buildCategoryContext(_userId: string): Promise<string> {
    throw new Error("Not implemented - Part 2");
  }

  async buildTransactionContext(
    _userId: string,
    _payeeName?: string,
  ): Promise<string> {
    throw new Error("Not implemented - Part 2");
  }
}

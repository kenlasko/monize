import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { QUERY_SYSTEM_PROMPT } from "./prompt-templates";
import { sanitizePromptValue } from "../../common/sanitization.util";

interface CategoryNode {
  id: string;
  name: string;
  isIncome: boolean;
  children?: CategoryNode[];
}

@Injectable()
export class FinancialContextBuilder {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => CategoriesService))
    private readonly categoriesService: CategoriesService,
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
  ) {}

  async buildQueryContext(userId: string): Promise<string> {
    const [accounts, categoryTree, preferences] = await Promise.all([
      this.accountsService.findAll(userId, false),
      this.categoriesService.getTree(userId),
      this.prefRepo.findOne({ where: { userId } }),
    ]);

    const currency = preferences?.defaultCurrency || "USD";
    const today = new Date().toISOString().substring(0, 10);

    // LLM06-F1: Only include account names and types, not balances.
    // Balances are available through the get_account_balances tool.
    const accountList = accounts
      .map(
        (a) =>
          `- ${sanitizePromptValue(a.name)} (${a.accountType}, ${a.currencyCode})`,
      )
      .join("\n");

    const categoryList = this.formatCategoryTree(categoryTree);

    return `${QUERY_SYSTEM_PROMPT}

TODAY'S DATE: ${today}
USER'S DEFAULT CURRENCY: ${currency}

<USER_DATA>
USER'S ACCOUNTS (use get_account_balances tool for balance details):
${accountList || "(No accounts configured)"}

USER'S CATEGORIES:
${categoryList || "(No categories configured)"}
</USER_DATA>`;
  }

  async buildCategoryContext(userId: string): Promise<string> {
    const categoryTree = await this.categoriesService.getTree(userId);
    return this.formatCategoryTree(categoryTree);
  }

  async buildTransactionContext(
    userId: string,
    _payeeName?: string,
  ): Promise<string> {
    const categoryTree = await this.categoriesService.getTree(userId);
    return this.formatCategoryTree(categoryTree);
  }

  private formatCategoryTree(categories: CategoryNode[], indent = 0): string {
    return categories
      .map((cat) => {
        const prefix = "  ".repeat(indent) + "- ";
        const type = cat.isIncome ? "[Income]" : "[Expense]";
        const safeName = sanitizePromptValue(cat.name);
        const children =
          cat.children && cat.children.length > 0
            ? "\n" + this.formatCategoryTree(cat.children, indent + 1)
            : "";
        return `${prefix}${safeName} ${type}${children}`;
      })
      .join("\n");
  }
}

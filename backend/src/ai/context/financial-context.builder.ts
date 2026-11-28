import { Injectable, Inject, forwardRef } from "@nestjs/common";
import {
  CategoryType,
  categoryTypeOf,
} from "../../categories/category-type.util";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { QUERY_SYSTEM_PROMPT } from "./prompt-templates";
import { aiLanguageInstruction } from "./language-directive";
import { sanitizePromptValue } from "../../common/sanitization.util";
import { preferredCurrency } from "../../common/default-currency.util";
import { todayYMD } from "../../common/date-utils";

interface CategoryNode {
  id: string;
  name: string;
  categoryType: CategoryType;
  children?: CategoryNode[];
}

const CATEGORY_TYPE_LABELS: Record<CategoryType, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
};

/** The type a category prints in the assistant's context. */
function categoryTypeLabel(category: CategoryNode): string {
  return CATEGORY_TYPE_LABELS[categoryTypeOf(category)];
}

@Injectable()
export class FinancialContextBuilder {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => CategoriesService))
    private readonly categoriesService: CategoriesService,
    private readonly dataSource: DataSource,
  ) {}

  async buildQueryContext(userId: string): Promise<string> {
    const [accounts, categoryTree, preferences] = await Promise.all([
      this.accountsService.findAll(userId, false),
      this.categoriesService.getTree(userId),
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(UserPreference).findOne({ where: { userId } }),
      ),
    ]);

    const currency = preferredCurrency(preferences);
    const today = todayYMD();

    // LLM06-F1: Only include account names and types, not balances.
    // Balances are available through the list_accounts tool.
    const accountList = accounts
      .map(
        (a) =>
          `- ${sanitizePromptValue(a.name)} (${a.accountType}, ${a.currencyCode})`,
      )
      .join("\n");

    const categoryList = this.formatCategoryTree(categoryTree);

    return `${QUERY_SYSTEM_PROMPT}${aiLanguageInstruction(preferences?.language)}

TODAY'S DATE: ${today}
USER'S DEFAULT CURRENCY: ${currency}

<USER_DATA>
USER'S ACCOUNTS (use list_accounts tool for balance details):
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
        const type = `[${categoryTypeLabel(cat)}]`;
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

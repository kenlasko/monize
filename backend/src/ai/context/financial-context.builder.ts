import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AccountsService } from "../../accounts/accounts.service";
import { CategoriesService } from "../../categories/categories.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { QUERY_SYSTEM_PROMPT } from "./prompt-templates";

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

    const accountList = accounts
      .map(
        (a) =>
          `- ${a.name} (${a.accountType}, ${a.currencyCode}, balance: ${Number(a.currentBalance).toFixed(2)})`,
      )
      .join("\n");

    const categoryList = this.formatCategoryTree(categoryTree);

    return `${QUERY_SYSTEM_PROMPT}

TODAY'S DATE: ${today}
USER'S DEFAULT CURRENCY: ${currency}

USER'S ACCOUNTS:
${accountList || "(No accounts configured)"}

USER'S CATEGORIES:
${categoryList || "(No categories configured)"}`;
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

  private formatCategoryTree(
    categories: CategoryNode[],
    indent = 0,
  ): string {
    return categories
      .map((cat) => {
        const prefix = "  ".repeat(indent) + "- ";
        const type = cat.isIncome ? "[Income]" : "[Expense]";
        const children =
          cat.children && cat.children.length > 0
            ? "\n" + this.formatCategoryTree(cat.children, indent + 1)
            : "";
        return `${prefix}${cat.name} ${type}${children}`;
      })
      .join("\n");
  }
}

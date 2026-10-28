import {
  beginTaxonomyOperation,
  recordTaxonomyOperation,
} from "../accruals/accrual-taxonomy-operation";
import {
  beginRelationshipHistory,
  recordRelationshipHistory,
} from "../accruals/accrual-relationship-history";
import { prepareCategoryMutation } from "./category-mutation";
import { verifyBulkAccrualEdit } from "../accruals/accrual-bulk-edit";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { tr, translateInLocale } from "../i18n/translate";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { IsNull, In, DataSource } from "typeorm";
import { Category } from "./entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  defaultCategoryNameKey,
  defaultSubcategoryNameKey,
} from "./default-category-i18n";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { toCountMap } from "../common/count-map.util";
import { getDefaultCategories } from "./country-category-additions";
import { isSupportedLocale } from "../i18n/config";
import { ImportDefaultsDto } from "./dto/import-defaults.dto";
import { withScopedDb } from "../common/db/scoped-db";
import { qualifiedCategoryName } from "./category-name.util";

@Injectable()
export class CategoriesService {
  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    private readonly i18n: I18nService,
  ) {}

  async create(
    userId: string,
    createCategoryDto: CreateCategoryDto,
  ): Promise<Category> {
    let isIncome = createCategoryDto.isIncome ?? false;

    if (createCategoryDto.parentId) {
      const parent = await this.findOne(userId, createCategoryDto.parentId);
      isIncome = parent.isIncome;
    }

    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Category);
      const category = repo.create({
        ...createCategoryDto,
        isIncome,
        userId,
      });
      return repo.save(category);
    });

    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        description: saved.description,
        icon: saved.icon,
        color: saved.color,
        isIncome: saved.isIncome,
        autoSign: saved.autoSign,
        parentId: saved.parentId,
        isSystem: saved.isSystem,
      },
      description: `Created category "${saved.name}"`,
      descriptionKey: "createdCategory",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  /**
   * Resolve the attributes a category inherits from its ancestors. Colour and
   * icon follow the same rule -- a category's own value wins, otherwise the
   * nearest ancestor that sets one -- so they are resolved in one traversal
   * rather than in two that could disagree about what "nearest" means.
   */
  private resolveInheritedAttributes<
    T extends {
      id: string;
      parentId: string | null;
      color: string | null;
      icon: string | null;
    },
  >(
    categories: T[],
  ): (T & { effectiveColor: string | null; effectiveIcon: string | null })[] {
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const resolved = new Map<string, string | null>();

    /** Nearest set value of `attribute`, walking up from `cat`. */
    const inherit = (cat: T, attribute: "color" | "icon"): string | null => {
      const key = `${attribute}:${cat.id}`;
      if (resolved.has(key)) {
        return resolved.get(key)!;
      }
      const own = cat[attribute];
      if (own !== null) {
        resolved.set(key, own);
        return own;
      }
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          const inherited = inherit(parent, attribute);
          resolved.set(key, inherited);
          return inherited;
        }
      }
      resolved.set(key, null);
      return null;
    };

    return categories.map((cat) => ({
      ...cat,
      effectiveColor: inherit(cat, "color"),
      effectiveIcon: inherit(cat, "icon"),
    }));
  }

  /**
   * Effective auto-sign per category: a category's own explicit value wins;
   * otherwise the nearest ancestor's explicit value; a root with none behaves
   * as on. Unlike isIncome, a category's own `autoSign` is never rewritten to
   * match an ancestor -- only this computed value is inherited.
   */
  private resolveEffectiveAutoSign<
    T extends { id: string; parentId: string | null; autoSign: boolean | null },
  >(categories: T[]): (T & { effectiveAutoSign: boolean })[] {
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const resolved = new Map<string, boolean>();

    const resolve = (cat: T): boolean => {
      if (resolved.has(cat.id)) return resolved.get(cat.id)!;
      if (cat.autoSign !== null) {
        resolved.set(cat.id, cat.autoSign);
        return cat.autoSign;
      }
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          const value = resolve(parent);
          resolved.set(cat.id, value);
          return value;
        }
      }
      resolved.set(cat.id, true);
      return true;
    };

    return categories.map((cat) => ({
      ...cat,
      effectiveAutoSign: resolve(cat),
    }));
  }

  async findAll(
    userId: string,
    includeSystem = false,
  ): Promise<(Category & { transactionCount: number })[]> {
    const categoriesWithCounts = await withScopedDb(
      this.dataSource,
      async (m) => {
        const queryBuilder = m
          .getRepository(Category)
          .createQueryBuilder("category")
          .where("category.userId = :userId", { userId })
          .orderBy("category.name", "ASC");

        if (!includeSystem) {
          queryBuilder.andWhere("category.isSystem = :isSystem", {
            isSystem: false,
          });
        }

        const categories = await queryBuilder.getMany();

        if (categories.length === 0) {
          return [];
        }

        const categoryIds = categories.map((c) => c.id);

        const directCounts = await m
          .getRepository(Transaction)
          .createQueryBuilder("t")
          .select("t.category_id", "categoryId")
          .addSelect("COUNT(t.id)", "count")
          .where("t.user_id = :userId", { userId })
          .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
          .groupBy("t.category_id")
          .getRawMany();
        const splitCounts = await m
          .getRepository(TransactionSplit)
          .createQueryBuilder("s")
          .innerJoin("s.transaction", "t")
          .select("s.category_id", "categoryId")
          .addSelect("COUNT(s.id)", "count")
          .where("t.user_id = :userId", { userId })
          .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
          .groupBy("s.category_id")
          .getRawMany();

        const countMap = toCountMap(directCounts, { keyField: "categoryId" });
        toCountMap(splitCounts, { keyField: "categoryId", into: countMap });

        return categories.map((category) => ({
          ...category,
          transactionCount: countMap.get(category.id) || 0,
        }));
      },
    );

    return this.resolveEffectiveAutoSign(
      this.resolveInheritedAttributes(categoriesWithCounts),
    );
  }

  async getTree(
    userId: string,
  ): Promise<(Category & { transactionCount: number })[]> {
    const allCategories = await this.findAll(userId, false);

    const categoryMap = new Map<
      string,
      Category & { children: Category[]; transactionCount: number }
    >();
    const rootCategories: (Category & {
      children: Category[];
      transactionCount: number;
    })[] = [];

    allCategories.forEach((cat) => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });

    allCategories.forEach((cat) => {
      const category = categoryMap.get(cat.id)!;
      if (cat.parentId) {
        const parent = categoryMap.get(cat.parentId);
        if (parent) {
          parent.children.push(category);
        } else {
          rootCategories.push(category);
        }
      } else {
        rootCategories.push(category);
      }
    });

    return rootCategories;
  }

  async findByType(
    userId: string,
    isIncome: boolean,
  ): Promise<
    (Category & {
      effectiveColor: string | null;
      effectiveIcon: string | null;
    })[]
  > {
    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId, isIncome },
        order: { name: "ASC" },
      }),
    );

    return this.resolveInheritedAttributes(categories);
  }

  /**
   * LLM-friendly category listing: returns a flat list with parent names so
   * the model can understand hierarchy without parsing nested JSON. Used by
   * both the AI Assistant and the MCP server to keep response shapes in sync.
   *
   * - `type` narrows to expense or income categories; 'all' (default)
   *   returns both.
   * - `search` is a case-insensitive substring match on category name. If the
   *   matching category is a subcategory, its parent is included so the LLM
   *   sees the hierarchy context.
   */
  async getLlmCategories(
    userId: string,
    options: {
      type?: "expense" | "income" | "all";
      search?: string;
    } = {},
  ): Promise<{
    categories: Array<{
      id: string;
      name: string;
      parentName: string | null;
      /**
       * The name to use when referring to this category anywhere else --
       * "Business: Cell Phone". A leaf name is not unique (the same chart of
       * accounts commonly has "Cell Phone" under both "Bills" and "Business"),
       * so a tool given `name` alone cannot tell which was meant and now
       * refuses rather than guessing.
       */
      qualifiedName: string;
      isIncome: boolean;
      transactionCount: number;
    }>;
    totalCount: number;
  }> {
    const type = options.type ?? "all";
    const search = options.search?.trim().toLowerCase();

    const all = await this.findAll(userId, false);
    const byId = new Map(all.map((c) => [c.id, c]));

    let filtered = all;
    if (type !== "all") {
      const wantIncome = type === "income";
      filtered = filtered.filter((c) => c.isIncome === wantIncome);
    }

    if (search) {
      const matchIds = new Set(
        filtered
          .filter((c) => c.name.toLowerCase().includes(search))
          .map((c) => c.id),
      );
      // Include parents of matched subcategories so hierarchy stays intact.
      for (const id of Array.from(matchIds)) {
        const cat = byId.get(id);
        if (cat?.parentId) matchIds.add(cat.parentId);
      }
      filtered = filtered.filter((c) => matchIds.has(c.id));
    }

    const categories = filtered
      .map((c) => {
        const parentName = c.parentId
          ? (byId.get(c.parentId)?.name ?? null)
          : null;
        return {
          id: c.id,
          name: c.name,
          parentName,
          qualifiedName: qualifiedCategoryName(c.name, parentName),
          isIncome: c.isIncome,
          transactionCount: c.transactionCount,
        };
      })
      .sort((a, b) => {
        // Parents first, then children, both alphabetized
        const aKey = a.parentName ?? a.name;
        const bKey = b.parentName ?? b.name;
        if (aKey !== bKey) return aKey.localeCompare(bKey);
        if (a.parentName === null && b.parentName !== null) return -1;
        if (a.parentName !== null && b.parentName === null) return 1;
        return a.name.localeCompare(b.name);
      });

    return {
      categories,
      totalCount: categories.length,
    };
  }

  async findOne(
    userId: string,
    id: string,
  ): Promise<
    Category & {
      effectiveColor: string | null;
      effectiveIcon: string | null;
      effectiveAutoSign: boolean;
    }
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Category);
      const category = await repo.findOne({
        where: { id, userId },
        relations: ["children"],
      });

      if (!category) {
        throw new NotFoundException(
          tr("errors.categories.notFound", `Category with ID ${id} not found`, {
            id,
          }),
        );
      }

      // Colour and icon are inherited by the same rule, so one walk up the
      // ancestry resolves both: each stops at the nearest ancestor that sets
      // it, and the walk ends once neither is still outstanding.
      let effectiveColor = category.color;
      let effectiveIcon = category.icon;
      let effectiveAutoSign: boolean | null = category.autoSign;
      let currentParentId: string | null = category.parentId;
      while (
        currentParentId !== null &&
        (effectiveColor === null ||
          effectiveIcon === null ||
          effectiveAutoSign === null)
      ) {
        const parent: Category | null = await repo.findOne({
          where: { id: currentParentId, userId },
          select: ["id", "color", "icon", "autoSign", "parentId"],
        });
        if (!parent) {
          break;
        }
        effectiveColor = effectiveColor ?? parent.color;
        effectiveIcon = effectiveIcon ?? parent.icon;
        effectiveAutoSign = effectiveAutoSign ?? parent.autoSign;
        currentParentId = parent.parentId;
      }

      return {
        ...category,
        effectiveColor,
        effectiveIcon,
        effectiveAutoSign: effectiveAutoSign ?? true,
      };
    });
  }

  async update(
    userId: string,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    const category = await this.findOne(userId, id);
    let recordedAccrualHistory = false;
    let beforeData = {
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      isIncome: category.isIncome,
      autoSign: category.autoSign,
      parentId: category.parentId,
    };

    if (category.isSystem) {
      throw new BadRequestException(
        tr(
          "errors.categories.cannotModifySystem",
          "Cannot modify system categories",
        ),
      );
    }

    if (updateCategoryDto.parentId) {
      if (updateCategoryDto.parentId === id) {
        throw new BadRequestException(
          tr(
            "errors.categories.selfParent",
            "Category cannot be its own parent",
          ),
        );
      }
      await this.findOne(userId, updateCategoryDto.parentId);

      // H16: Check for circular parent reference through the hierarchy
      const allCategories = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).find({
          where: { userId },
          select: ["id", "parentId"],
        }),
      );
      const categoryMap = new Map(allCategories.map((c) => [c.id, c.parentId]));
      categoryMap.set(id, updateCategoryDto.parentId);
      let current: string | null | undefined = updateCategoryDto.parentId;
      const visited = new Set<string>([id]);
      while (current) {
        if (visited.has(current)) {
          throw new BadRequestException(
            tr(
              "errors.categories.circularParent",
              "Circular parent reference detected",
            ),
          );
        }
        visited.add(current);
        current = categoryMap.get(current) ?? null;
      }
    }

    // SECURITY: Explicit property mapping instead of Object.assign to prevent mass assignment
    if (updateCategoryDto.name !== undefined)
      category.name = updateCategoryDto.name;
    if (updateCategoryDto.description !== undefined)
      category.description = updateCategoryDto.description;
    if (updateCategoryDto.icon !== undefined)
      category.icon = updateCategoryDto.icon;
    if (updateCategoryDto.color !== undefined)
      category.color = updateCategoryDto.color;
    if (updateCategoryDto.autoSign !== undefined)
      category.autoSign = updateCategoryDto.autoSign;
    if (updateCategoryDto.parentId !== undefined)
      category.parentId = updateCategoryDto.parentId;

    // Inherit type from parent - child categories must match parent type
    if (category.parentId) {
      const parent = await this.findOne(userId, category.parentId);
      category.isIncome = parent.isIncome;
    } else if (updateCategoryDto.isIncome !== undefined) {
      category.isIncome = updateCategoryDto.isIncome;
    }

    // Save the category and cascade any type change to all descendant
    // subcategories atomically, so a partial failure cannot leave children
    // with a type that disagrees with their parent.
    const saved = await withScopedDb(this.dataSource, async (m) => {
      const edit = await prepareCategoryMutation(m, userId, id, {
        operation: "update",
        dto: updateCategoryDto,
      });
      verifyBulkAccrualEdit(
        edit.preview,
        updateCategoryDto.accrualImpactFingerprint,
      );
      beforeData = {
        name: edit.category.name,
        description: edit.category.description,
        icon: edit.category.icon,
        color: edit.category.color,
        isIncome: edit.category.isIncome,
        autoSign: edit.category.autoSign,
        parentId: edit.category.parentId,
      };
      const relationshipBefore = await beginRelationshipHistory(
        m,
        userId,
        "category",
        id,
        edit.sources.map((row) => row.id),
        edit.affected,
      );
      const { snapshot: _ignored, ...live } = edit.category;
      const fields = {
        ...live,
        parentId: edit.parentId,
        isIncome: edit.newIncome,
      };
      for (const key of [
        "name",
        "description",
        "icon",
        "color",
        "autoSign",
      ] as const)
        if (updateCategoryDto[key] !== undefined)
          Object.assign(fields, { [key]: updateCategoryDto[key] });
      const savedCategory = await m.save(Category, fields);
      for (const changedId of edit.families.keys())
        if (changedId !== id)
          await m.update(
            Category,
            { id: changedId, userId },
            { isIncome: edit.newIncome },
          );
      for (const impact of edit.preview.impacts)
        await refreshSourceAccruals(m, userId, impact.transactionId);
      if (relationshipBefore) {
        await recordRelationshipHistory(m, userId, relationshipBefore);
        recordedAccrualHistory = true;
      }
      return savedCategory;
    });

    if (!recordedAccrualHistory)
      this.actionHistoryService.record(userId, {
        entityType: "category",
        entityId: id,
        action: "update",
        beforeData,
        afterData: {
          name: saved.name,
          description: saved.description,
          icon: saved.icon,
          color: saved.color,
          isIncome: saved.isIncome,
          autoSign: saved.autoSign,
          parentId: saved.parentId,
        },
        description: `Updated category "${saved.name}"`,
        descriptionKey: "updatedCategory",
        descriptionParams: { name: saved.name },
      });
    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const category = await this.findOne(userId, id);

    if (category.isSystem) {
      throw new BadRequestException(
        tr(
          "errors.categories.cannotDeleteSystem",
          "Cannot delete system categories",
        ),
      );
    }

    const childCount = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).count({
        where: { parentId: id, userId },
      }),
    );

    if (childCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.hasSubcategories",
          "Cannot delete category with subcategories. Delete or reassign subcategories first.",
        ),
      );
    }

    // M23: Check for referencing transactions before deletion
    const transactionCount = await this.getTransactionCount(userId, id);
    if (transactionCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.hasTransactions",
          `Cannot delete category with ${transactionCount} referencing transaction(s). Reassign transactions first.`,
          { count: transactionCount },
        ),
      );
    }

    let beforeData = {
      id: category.id,
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      isIncome: category.isIncome,
      parentId: category.parentId,
      isSystem: category.isSystem,
    };

    // Clear the default-category reference on any payees and delete the
    // category atomically, so a failure cannot leave payees pointing at a
    // category that no longer exists.
    let relationshipRecorded = false;
    await withScopedDb(this.dataSource, async (m) => {
      const history = await beginTaxonomyOperation(m, userId, "category", [id]);
      const edit = await prepareCategoryMutation(m, userId, id, {
        operation: "delete",
      });
      if (edit.category.isSystem)
        throw new BadRequestException(
          tr(
            "errors.categories.cannotDeleteSystem",
            "Cannot delete system categories",
          ),
        );
      if (edit.graph.some((row) => row.parentId === id))
        throw new BadRequestException(
          tr(
            "errors.categories.hasSubcategories",
            "Cannot delete category with subcategories. Delete or reassign subcategories first.",
          ),
        );
      const references = await this.getTransactionCount(userId, id);
      if (references > 0)
        throw new BadRequestException(
          tr(
            "errors.categories.hasTransactions",
            `Cannot delete category with ${references} referencing transaction(s). Reassign transactions first.`,
            { count: references },
          ),
        );
      beforeData = {
        id: edit.category.id,
        name: edit.category.name,
        description: edit.category.description,
        icon: edit.category.icon,
        color: edit.category.color,
        isIncome: edit.category.isIncome,
        parentId: edit.category.parentId,
        isSystem: edit.category.isSystem,
      };
      await m.update(
        Payee,
        { userId, defaultCategoryId: id },
        { defaultCategoryId: null },
      );
      // Explicit entity target: `category` here is a plain object from
      // findOne (spread with effectiveColor), not a Category instance.
      await m.remove(Category, category);
      await recordTaxonomyOperation(m, userId, history);
      relationshipRecorded = !!history;
    });

    if (relationshipRecorded) return;
    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted category "${beforeData.name}"`,
      descriptionKey: "deletedCategory",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getTransactionCount(
    userId: string,
    categoryId: string,
  ): Promise<number> {
    await this.findOne(userId, categoryId);

    return withScopedDb(this.dataSource, async (m) => {
      const transactionCount = await m
        .getRepository(Transaction)
        .count({ where: { userId, categoryId } });
      const splitCount = await m
        .getRepository(TransactionSplit)
        .createQueryBuilder("split")
        .innerJoin("split.transaction", "transaction")
        .where("split.categoryId = :categoryId", { categoryId })
        .andWhere("transaction.userId = :userId", { userId })
        .getCount();
      const scheduledCount = await m.getRepository(ScheduledTransaction).count({
        where: { userId, categoryId },
      });
      const userScheduledTxIds = await m
        .getRepository(ScheduledTransaction)
        .createQueryBuilder("st")
        .select("st.id")
        .where("st.userId = :userId", { userId })
        .getMany();

      let scheduledSplitCount = 0;
      if (userScheduledTxIds.length > 0) {
        const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
        scheduledSplitCount = await m
          .getRepository(ScheduledTransactionSplit)
          .createQueryBuilder("ss")
          .where("ss.categoryId = :categoryId", { categoryId })
          .andWhere("ss.scheduledTransactionId IN (:...scheduledTxIds)", {
            scheduledTxIds,
          })
          .getCount();
      }

      return (
        transactionCount + splitCount + scheduledCount + scheduledSplitCount
      );
    });
  }

  async previewCategoryUpdate(
    userId: string,
    id: string,
    dto: UpdateCategoryDto,
  ) {
    await this.findOne(userId, id);
    return withScopedDb(this.dataSource, async (m) => {
      const edit = await prepareCategoryMutation(m, userId, id, {
        operation: "update",
        dto,
      });
      return {
        ...edit.preview,
        categoryIds: edit.affected,
        changedCategoryIds: [...edit.families.keys()],
        parentId: edit.parentId,
        isIncome: edit.newIncome,
      };
    });
  }

  async previewCategoryReassignment(
    userId: string,
    id: string,
    toCategoryId: string | null,
  ) {
    await this.findOne(userId, id);
    return withScopedDb(
      this.dataSource,
      async (m) =>
        (
          await prepareCategoryMutation(m, userId, id, {
            operation: "reassign",
            toCategoryId,
          })
        ).preview,
    );
  }

  async reassignTransactions(
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
    accrualImpactFingerprint?: string,
  ): Promise<{
    transactionsUpdated: number;
    splitsUpdated: number;
    scheduledUpdated: number;
  }> {
    await this.findOne(userId, fromCategoryId);

    if (toCategoryId) {
      await this.findOne(userId, toCategoryId);
    }

    // M22: All UPDATE operations run in a single transaction.
    return withScopedDb(this.dataSource, async (m) => {
      const history = await beginTaxonomyOperation(m, userId, "category", [
        fromCategoryId,
        ...(toCategoryId ? [toCategoryId] : []),
      ]);
      const edit = await prepareCategoryMutation(m, userId, fromCategoryId, {
        operation: "reassign",
        toCategoryId,
      });
      verifyBulkAccrualEdit(edit.preview, accrualImpactFingerprint);
      const transactionIds = edit.sources.map((row) => row.id);
      const transactionResult = transactionIds.length
        ? await m.update(
            Transaction,
            { userId, id: In(transactionIds), categoryId: fromCategoryId },
            { categoryId: toCategoryId },
          )
        : { affected: 0 };

      let splitsUpdated = 0;
      if (transactionIds.length > 0) {
        const splitResult = await m
          .createQueryBuilder()
          .update(TransactionSplit)
          .set({ categoryId: toCategoryId })
          .where("categoryId = :fromCategoryId", { fromCategoryId })
          .andWhere("transactionId IN (:...transactionIds)", { transactionIds })
          .execute();

        splitsUpdated = splitResult.affected || 0;
      }

      const scheduledResult = await m.update(
        ScheduledTransaction,
        { userId, categoryId: fromCategoryId },
        { categoryId: toCategoryId },
      );

      const userScheduledTxIds = await m
        .createQueryBuilder(ScheduledTransaction, "st")
        .select("st.id")
        .where("st.userId = :userId", { userId })
        .getMany();

      if (userScheduledTxIds.length > 0) {
        const scheduledTxIds = userScheduledTxIds.map((st) => st.id);
        await m
          .createQueryBuilder()
          .update(ScheduledTransactionSplit)
          .set({ categoryId: toCategoryId })
          .where("categoryId = :fromCategoryId", { fromCategoryId })
          .andWhere("scheduledTransactionId IN (:...scheduledTxIds)", {
            scheduledTxIds,
          })
          .execute();
      }

      for (const impact of edit.preview.impacts)
        await refreshSourceAccruals(m, userId, impact.transactionId);
      await recordTaxonomyOperation(m, userId, history);
      return {
        transactionsUpdated: transactionResult.affected || 0,
        splitsUpdated,
        scheduledUpdated: scheduledResult.affected || 0,
      };
    });
  }

  async getStats(userId: string): Promise<{
    totalCategories: number;
    incomeCategories: number;
    expenseCategories: number;
    subcategories: number;
  }> {
    const categories = await this.findAll(userId, false);

    const incomeCategories = categories.filter((c) => c.isIncome).length;
    const expenseCategories = categories.filter((c) => !c.isIncome).length;
    const subcategories = categories.filter((c) => c.parentId !== null).length;

    return {
      totalCategories: categories.length,
      incomeCategories,
      expenseCategories,
      subcategories,
    };
  }

  async findByName(
    userId: string,
    name: string,
    parentName?: string,
  ): Promise<Category | null> {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Category);
      if (parentName) {
        const parent = await repo.findOne({
          where: { userId, name: parentName, parentId: IsNull() },
        });

        if (!parent) {
          return null;
        }

        return repo.findOne({
          where: { userId, name, parentId: parent.id },
        });
      }

      return repo.findOne({
        where: { userId, name },
      });
    });
  }

  async importDefaults(
    userId: string,
    options: ImportDefaultsDto = {},
  ): Promise<{ categoriesCreated: number }> {
    const existingCount = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).count({
        where: { userId, isSystem: false },
      }),
    );

    if (existingCount > 0) {
      throw new BadRequestException(
        tr(
          "errors.categories.alreadyHasCategories",
          "Cannot import defaults: user already has categories. Delete existing categories first or start fresh.",
        ),
      );
    }

    // Seed the rows in the language the user picked for this import, falling
    // back to their own stored language rather than the request locale. The
    // names become user-owned, editable rows, so this localizes only what is
    // created now; already-imported categories are untouched. Missing catalog
    // keys fall back to the English source.
    const lang = isSupportedLocale(options.language)
      ? (options.language as string)
      : await withScopedDb(this.dataSource, (m) =>
          resolveUserEmailLocale(m.getRepository(UserPreference), userId),
        );
    const localizeCategory = (name: string): string =>
      translateInLocale(this.i18n, lang, defaultCategoryNameKey(name), name);
    const localizeSubcategory = (parentName: string, name: string): string =>
      translateInLocale(
        this.i18n,
        lang,
        defaultSubcategoryNameKey(parentName, name),
        name,
      );

    // Country-specific additions (tax lines, benefits, local charges) are
    // layered over the country-neutral baseline; an omitted or unknown country
    // yields the generic catalog.
    const { income, expense } = getDefaultCategories(options.country);

    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Category);
      let categoryCount = 0;

      for (const cat of income) {
        const parentCategory = repo.create({
          userId,
          name: localizeCategory(cat.name),
          isIncome: true,
        });
        const savedParent = await repo.save(parentCategory);
        categoryCount++;

        for (const subName of cat.subcategories) {
          const subCategory = repo.create({
            userId,
            parentId: savedParent.id,
            name: localizeSubcategory(cat.name, subName),
            isIncome: true,
          });
          await repo.save(subCategory);
          categoryCount++;
        }
      }

      for (const cat of expense) {
        const parentCategory = repo.create({
          userId,
          name: localizeCategory(cat.name),
          isIncome: false,
        });
        const savedParent = await repo.save(parentCategory);
        categoryCount++;

        for (const subName of cat.subcategories) {
          const subCategory = repo.create({
            userId,
            parentId: savedParent.id,
            name: localizeSubcategory(cat.name, subName),
            isIncome: false,
          });
          await repo.save(subCategory);
          categoryCount++;
        }
      }

      return { categoriesCreated: categoryCount };
    });
  }
}

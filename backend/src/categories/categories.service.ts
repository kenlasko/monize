import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { tr, translateInLocale } from "../i18n/translate";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { IsNull, DataSource, EntityManager } from "typeorm";
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
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { toCountMap } from "../common/count-map.util";
import { getDefaultCategories } from "./country-category-additions";
import { isSupportedLocale } from "../i18n/config";
import { ImportDefaultsDto } from "./dto/import-defaults.dto";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { hasMovedRows, MovedCategoryRows } from "./category-moved-rows";
import {
  recordInUseException,
  recordInUseSummary,
} from "../common/helpers/record-in-use";
import { UNCATEGORIZED } from "./dto/remove-category-query.dto";
import {
  countCategoryUsage,
  findCategoryReferences,
} from "./category-references";
import { qualifiedCategoryName } from "./category-name.util";
import { searchIncludes } from "../common/helpers/search-match";
import {
  lockCategoryOwnerExclusive,
  lockCategoryOwnerShared,
} from "../common/db/locks";
import {
  categoryFits,
  fitCategory,
  transferCategoryRefusal,
} from "./category-fit";
import {
  CategoryType,
  categoryTypeOf,
  isExpenseCategory,
  isIncomeCategory,
  isTransferCategory,
} from "./category-type.util";

@Injectable()
export class CategoriesService {
  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    private readonly i18n: I18nService,
  ) {}

  /** A subcategory has its parent's type; a request naming another is refused. */
  private assertChildTypeMatches(
    requested: CategoryType | undefined,
    parentType: CategoryType,
    parentName: string,
  ): void {
    if (requested !== undefined && requested !== parentType) {
      throw new BadRequestException(
        tr(
          "errors.categories.childTypeMismatch",
          "A subcategory has the type of its parent, {{ parent }} ({{ type }})",
          { parent: parentName, type: parentType },
        ),
      );
    }
  }

  async create(
    userId: string,
    createCategoryDto: CreateCategoryDto,
  ): Promise<Category> {
    const { type: requestedType, ...rest } = createCategoryDto;
    let type: CategoryType = requestedType ?? "expense";

    if (createCategoryDto.parentId) {
      const parent = await this.findOne(userId, createCategoryDto.parentId);
      const parentType = categoryTypeOf(parent);
      this.assertChildTypeMatches(requestedType, parentType, parent.name);
      type = parentType;
    }

    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Category);
      const category = repo.create({
        ...rest,
        categoryType: type,
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
        categoryType: saved.categoryType,
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
   * as on. Unlike the type, a category's own `autoSign` is never rewritten to
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
  ): Promise<(Category & { transactionCount: number; usageCount: number })[]> {
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

        // What the delete refuses for, so the list never reads 0 on a 409.
        const usageMap = await countCategoryUsage(m, userId);

        return categories.map((category) => ({
          ...category,
          transactionCount: countMap.get(category.id) || 0,
          usageCount: usageMap.get(category.id) || 0,
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

  /** The income (`true`) or expense (`false`) categories of the person. */
  findByType(userId: string, isIncome: boolean) {
    return this.findByCategoryType(userId, isIncome ? "income" : "expense");
  }

  async findByCategoryType(
    userId: string,
    type: CategoryType,
  ): Promise<
    (Category & {
      effectiveColor: string | null;
      effectiveIcon: string | null;
    })[]
  > {
    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId, categoryType: type },
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
   * - `type` narrows to income, expense or transfer categories; 'all'
   *   (default) returns every type.
   * - `search` is a case- and punctuation-insensitive substring match on
   *   category name. If the matching category is a subcategory, its parent is
   *   included so the LLM sees the hierarchy context.
   */
  async getLlmCategories(
    userId: string,
    options: {
      type?: CategoryType | "all";
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
      /** income, expense or transfer: a Transfer category goes only on a transfer. */
      type: CategoryType;
      transactionCount: number;
    }>;
    totalCount: number;
  }> {
    const type = options.type ?? "all";
    const search = options.search?.trim();

    const all = await this.findAll(userId, false);
    const byId = new Map(all.map((c) => [c.id, c]));

    let filtered = all;
    if (type !== "all") {
      filtered = filtered.filter((c) => categoryTypeOf(c) === type);
    }

    if (search) {
      const matchIds = new Set(
        filtered.filter((c) => searchIncludes(c.name, search)).map((c) => c.id),
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
          type: categoryTypeOf(c),
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
    // A type change or a move takes the category-owner lock exclusive as the
    // first statement of its transaction, before any row lock, so a write that
    // sets a category on a row either finished before the holders are counted
    // or waits for this commit (INV-CATEGORY-001, `docs/concurrency-and-idempotency.md`
    // section 5). The nested `withScopedDb` calls below join this transaction.
    const mayRetype =
      updateCategoryDto.type !== undefined ||
      updateCategoryDto.parentId !== undefined;
    const { saved, beforeData } = await withScopedDb(
      this.dataSource,
      async (m) => {
        if (mayRetype) await lockCategoryOwnerExclusive(m, userId);
        return this.updateUnderLock(userId, id, updateCategoryDto, m);
      },
    );

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
        categoryType: saved.categoryType,
        autoSign: saved.autoSign,
        parentId: saved.parentId,
      },
      description: `Updated category "${saved.name}"`,
      descriptionKey: "updatedCategory",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  private async updateUnderLock(
    userId: string,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
    m: EntityManager,
  ): Promise<{ saved: Category; beforeData: Record<string, unknown> }> {
    const category = await this.findOne(userId, id);
    const beforeType = categoryTypeOf(category);
    const beforeData = {
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      categoryType: beforeType,
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
    const moved =
      updateCategoryDto.parentId !== undefined &&
      updateCategoryDto.parentId !== category.parentId;
    if (updateCategoryDto.parentId !== undefined)
      category.parentId = updateCategoryDto.parentId;

    // A moved category takes its new parent's type, and so does its whole
    // subtree (INV-CATEGORY-003). One that stays where it is keeps its own
    // type: an existing child whose type differs from its parent's stays as it
    // is until it, or an ancestor, is moved or re-typed. A top-level category
    // takes the type the request names.
    let newType: CategoryType = beforeType;
    if (category.parentId) {
      if (moved) {
        const parent = await this.findOne(userId, category.parentId);
        newType = categoryTypeOf(parent);
        this.assertChildTypeMatches(
          updateCategoryDto.type,
          newType,
          parent.name,
        );
      } else if (updateCategoryDto.type !== undefined) {
        const parent = await this.findOne(userId, category.parentId);
        this.assertChildTypeMatches(
          updateCategoryDto.type,
          categoryTypeOf(parent),
          parent.name,
        );
      }
    } else {
      newType = updateCategoryDto.type ?? beforeType;
    }
    category.categoryType = newType;

    const retyped = newType !== beforeType;
    if (newType === "transfer" && (retyped || moved)) {
      await this.assertSubtreeNotHeld(userId, category, m);
    }

    // Save the category and cascade any type change to all descendant
    // subcategories atomically, so a partial failure cannot leave children
    // with a type that disagrees with their parent.
    // Pass the explicit entity target: findOne returns a plain object
    // (spread with effectiveColor), not a Category instance, so the
    // single-arg form would throw CannotDetermineEntityError.
    const savedCategory = await m.save(Category, category);
    if (retyped || moved) {
      await this.updateDescendantTypes(userId, id, newType, m);
    }

    return { saved: savedCategory, beforeData };
  }

  /**
   * Refuse turning a category, or a subtree, into Transfer categories while a
   * category row holds one of them (`category_held_by_category_row`: an
   * ordinary row, a split's category line, a scheduled category row, an
   * override that can still post, a payee default, an asset category, a
   * payroll rule, a loan's interest or fee category). A Transfer category
   * becoming Income or Expense is always allowed: every holder is a transfer
   * row and a transfer takes any type.
   */
  private async assertSubtreeNotHeld(
    userId: string,
    category: { id: string; name: string },
    m: EntityManager,
  ): Promise<void> {
    const all =
      (await m.getRepository(Category).find({
        where: { userId },
        select: ["id", "parentId", "name", "categoryType"],
      })) ?? [];
    const childrenOf = new Map<string, Category[]>();
    for (const c of all) {
      if (c.parentId) {
        childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c]);
      }
    }
    const subtree: { id: string; name: string }[] = [category];
    for (let i = 0; i < subtree.length; i++) {
      for (const child of childrenOf.get(subtree[i].id) ?? []) {
        subtree.push(child);
      }
    }
    const held = (await m.query(
      `SELECT id FROM unnest($1::uuid[]) AS id WHERE category_held_by_category_row(id)`,
      [subtree.map((c) => c.id)],
    )) as { id: string }[] | undefined;
    if (held && held.length > 0) {
      const names = new Map(subtree.map((c) => [c.id, c.name]));
      throw new BadRequestException(
        tr(
          "errors.categories.typeChangeHeld",
          "{{ name }} cannot become a Transfer category: a transaction, a schedule or a setting that takes only an Income or Expense category uses it. Reassign them first.",
          { name: names.get(held[0].id) ?? category.name },
        ),
      );
    }
  }

  private async updateDescendantTypes(
    userId: string,
    parentId: string,
    type: CategoryType,
    manager: EntityManager,
  ): Promise<void> {
    const children = await manager.find(Category, {
      where: { userId, parentId },
      select: ["id"],
    });

    if (children.length === 0) {
      return;
    }

    for (const child of children) {
      await manager.update(
        Category,
        { id: child.id, userId },
        { categoryType: type },
      );
      await this.updateDescendantTypes(userId, child.id, type, manager);
    }
  }

  /**
   * Delete a category. With `reassignTo` (a category id or `uncategorized`) its
   * rows are moved first, in the same transaction as the in-use check, so a
   * refusal rolls the move back and a refused delete has moved nothing.
   */
  async remove(userId: string, id: string, reassignTo?: string): Promise<void> {
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

    const beforeData = {
      id: category.id,
      name: category.name,
      description: category.description,
      icon: category.icon,
      color: category.color,
      categoryType: categoryTypeOf(category),
      parentId: category.parentId,
      isSystem: category.isSystem,
    };

    // Lock, count and delete in one transaction: a reference committed while
    // this waits for the lock is counted, and a refusal has written nothing.
    // The payees' default-category reference is cleared with the delete, so a
    // failure cannot leave a payee pointing at a category that is gone.
    let movedRows: MovedCategoryRows | undefined;
    await withScopedDb(this.dataSource, async (m) => {
      // Rows moved onto a category are fitted under the shared category-owner
      // lock, taken before any row lock (`common/db/locks.ts`).
      const targetId = reassignTo?.toLowerCase();
      if (targetId && targetId !== UNCATEGORIZED) {
        await lockCategoryOwnerShared(m, userId);
      }
      // Both rows are locked in id order, so two deletes that each move rows
      // into the other cannot deadlock; the target's lookup below re-takes it.
      if (
        targetId &&
        targetId !== UNCATEGORIZED &&
        targetId < id.toLowerCase()
      ) {
        await m.getRepository(Category).findOne({
          where: { id: targetId, userId },
          lock: { mode: "pessimistic_read" },
        });
      }
      const locked = await m.getRepository(Category).findOne({
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!locked) {
        throw new NotFoundException(
          tr("errors.categories.notFound", `Category with ID ${id} not found`, {
            id,
          }),
        );
      }
      if (reassignTo !== undefined) {
        let target: string | null = null;
        // A UUID is valid in either case; stored JSON ids are lowercase.
        reassignTo = reassignTo.toLowerCase();
        if (reassignTo !== UNCATEGORIZED) {
          if (reassignTo === id.toLowerCase()) {
            throw new BadRequestException(
              tr(
                "errors.categories.reassignToSelf",
                "Cannot reassign a category's rows to the category being deleted",
              ),
            );
          }
          // Locked FOR SHARE: a concurrent delete of the target waits.
          const found = await m.getRepository(Category).findOne({
            where: { id: reassignTo, userId },
            lock: { mode: "pessimistic_read" },
          });
          if (!found) {
            throw new NotFoundException(
              tr(
                "errors.categories.notFound",
                `Category with ID ${reassignTo} not found`,
                { id: reassignTo },
              ),
            );
          }
          target = reassignTo;
        }
        // A Transfer target takes no category row (INV-CATEGORY-001): the
        // delete is refused with nothing moved, as the reassign route is.
        await this.assertReassignTargetFits(m, userId, id, target);
        const result = await this.reassignCategoryRows(m, userId, id, target);
        if (hasMovedRows(result.moved)) movedRows = result.moved;
      }
      const references = await findCategoryReferences(m, userId, id);
      if (references.length > 0) {
        const summary = recordInUseSummary(references);
        throw recordInUseException(
          tr(
            "errors.categories.inUse",
            `Category "${locked.name}" cannot be deleted: it is still used by ${summary}. Reassign or remove these first.`,
            { name: locked.name, summary },
          ),
          references,
        );
      }
      await m.update(
        Payee,
        { userId, defaultCategoryId: id },
        { defaultCategoryId: null },
      );
      await m.remove(Category, locked);
    });

    this.actionHistoryService.record(userId, {
      entityType: "category",
      entityId: id,
      action: "delete",
      // The moved ids let the undo move them back; an entry over the history's
      // size limit is not recorded at all, which is safer than a wrong undo.
      beforeData: movedRows ? { ...beforeData, movedRows } : beforeData,
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
      // Joins, not an id list: a user's ids can exceed the 65535 bind limit.
      const lowerId = categoryId.toLowerCase();
      const [{ count: scheduledSplitCount }] = await m.query(
        `SELECT count(*)::int AS count FROM scheduled_transaction_splits s
           JOIN scheduled_transactions t ON t.id = s.scheduled_transaction_id
          WHERE t.user_id = $1 AND s.category_id = $2`,
        [userId, lowerId],
      );
      // Overrides keep a category of their own and one per split line in JSON;
      // `reassignCategoryRows` moves both, so the dialog must offer the move.
      const [{ count: overrideCount }] = await m.query(
        `SELECT count(*)::int AS count FROM scheduled_transaction_overrides o
           JOIN scheduled_transactions t ON t.id = o.scheduled_transaction_id
          WHERE t.user_id = $1
            AND (o.category_id = $2 OR o.splits::text LIKE '%' || $2::text || '%')`,
        [userId, lowerId],
      );

      return (
        transactionCount +
        splitCount +
        scheduledCount +
        Number(scheduledSplitCount) +
        Number(overrideCount)
      );
    });
  }

  async reassignTransactions(
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{
    transactionsUpdated: number;
    splitsUpdated: number;
    scheduledUpdated: number;
  }> {
    await this.findOne(userId, fromCategoryId);

    // M22: All UPDATE operations run in a single transaction.
    return withScopedDb(this.dataSource, async (m) => {
      // The target is the person's, read under the shared owner lock (taken
      // first, before any row lock), and fits the rows the reassign moves
      // (INV-CATEGORY-001). Decided before the first write.
      if (toCategoryId) await lockCategoryOwnerShared(m, userId);
      await this.assertReassignTargetFits(
        m,
        userId,
        fromCategoryId,
        toCategoryId,
      );
      const r = await this.reassignCategoryRows(
        m,
        userId,
        fromCategoryId,
        toCategoryId,
      );
      return {
        transactionsUpdated: r.transactionsUpdated,
        splitsUpdated: r.splitsUpdated,
        scheduledUpdated: r.scheduledUpdated,
      };
    });
  }

  /**
   * Whether a row a reassign moves is a category row holding the category:
   * an ordinary transaction, a split's category line, a scheduled ordinary
   * transaction or a scheduled split's category line.
   */
  private async categoryRowsHold(
    m: EntityManager,
    userId: string,
    categoryId: string,
  ): Promise<boolean> {
    const [row] = await m.query(
      `SELECT EXISTS (
         SELECT 1 FROM transactions
          WHERE user_id = $1 AND category_id = $2 AND is_transfer IS NOT TRUE
         UNION ALL SELECT 1 FROM transaction_splits s
           JOIN transactions t ON t.id = s.transaction_id
          WHERE t.user_id = $1 AND s.category_id = $2
            AND s.transfer_account_id IS NULL
         UNION ALL SELECT 1 FROM scheduled_transactions
          WHERE user_id = $1 AND category_id = $2 AND is_transfer IS NOT TRUE
         UNION ALL SELECT 1 FROM scheduled_transaction_splits ss
           JOIN scheduled_transactions st ON st.id = ss.scheduled_transaction_id
          WHERE st.user_id = $1 AND ss.category_id = $2
            AND ss.transfer_account_id IS NULL
       ) AS held`,
      [userId, categoryId],
    );
    return row?.held === true;
  }

  /**
   * A reassign's target fits the rows it moves (INV-CATEGORY-001): the
   * person's category, and a Transfer category only while no category row
   * holds `fromCategoryId` (a transfer takes any type). A refusal moves
   * nothing. The caller holds the shared category-owner lock.
   */
  private async assertReassignTargetFits(
    m: EntityManager,
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<void> {
    const target = await fitCategory(m, userId, toCategoryId, "transfer", {
      notFound: () =>
        new NotFoundException(
          tr(
            "errors.categories.notFound",
            `Category with ID ${toCategoryId} not found`,
            { id: toCategoryId },
          ),
        ),
    });
    if (
      target &&
      !categoryFits(target, "category") &&
      (await this.categoryRowsHold(m, userId, fromCategoryId))
    ) {
      throw transferCategoryRefusal(target.name);
    }
  }

  /**
   * Point every row of `fromCategoryId` at `toCategoryId` (null clears it) on
   * the caller's manager, so a delete can run it in its own transaction.
   */
  private async reassignCategoryRows(
    m: EntityManager,
    userId: string,
    fromCategoryId: string,
    toCategoryId: string | null,
  ): Promise<{
    transactionsUpdated: number;
    splitsUpdated: number;
    scheduledUpdated: number;
    moved: MovedCategoryRows;
  }> {
    fromCategoryId = fromCategoryId.toLowerCase();
    toCategoryId = toCategoryId?.toLowerCase() ?? null;
    const ids = async (sql: string) =>
      returnedRows<{ id: string }>(
        await m.query(sql, [toCategoryId, userId, fromCategoryId]),
      ).map((r) => r.id);
    // Each UPDATE returns the ids it moved, for the delete's undo. The two
    // entity tables keep the `updated_at` the entity update used to stamp.
    const transactions = await ids(
      // category-fit-ok: the caller fitted the target (assertReassignTargetFits)
      `UPDATE transactions SET category_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2 AND category_id = $3 RETURNING id`,
    );
    // Joins, not an id list: a user's ids can exceed the 65535 bind limit.
    const transactionSplits = await ids(
      // category-fit-ok: the caller fitted the target (assertReassignTargetFits)
      `UPDATE transaction_splits s SET category_id = $1
           FROM transactions t
          WHERE t.id = s.transaction_id AND t.user_id = $2
            AND s.category_id = $3 RETURNING s.id`,
    );
    const scheduled = await ids(
      // category-fit-ok: the caller fitted the target (assertReassignTargetFits)
      `UPDATE scheduled_transactions SET category_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2 AND category_id = $3 RETURNING id`,
    );
    const scheduledSplits = await ids(
      // category-fit-ok: the caller fitted the target (assertReassignTargetFits)
      `UPDATE scheduled_transaction_splits s SET category_id = $1
           FROM scheduled_transactions t
          WHERE t.id = s.scheduled_transaction_id AND t.user_id = $2
            AND s.category_id = $3 RETURNING s.id`,
    );

    // Overrides keep a category of their own and, in `splits` JSON, one per
    // split line; neither is reached by the updates above.
    const overrides = await ids(
      // category-fit-ok: the caller fitted the target (assertReassignTargetFits)
      `UPDATE scheduled_transaction_overrides o SET category_id = $1
           FROM scheduled_transactions t
          WHERE t.id = o.scheduled_transaction_id AND t.user_id = $2
            AND o.category_id = $3 RETURNING o.id`,
    );
    // shortcut: a text replace of the quoted UUID in the JSON; exact for
    // UUIDs, which are unique and appear only as category ids in a split.
    // The CTE locks the rows and keeps the value read, so `before` is the one
    // the rewrite replaced.
    const overrideSplits = returnedRows<{
      id: string;
      before: unknown;
      after: unknown;
    }>(
      await m.query(
        `WITH old AS (
           SELECT o.id, o.splits FROM scheduled_transaction_overrides o
             JOIN scheduled_transactions t ON t.id = o.scheduled_transaction_id
            WHERE t.user_id = $2 AND o.splits::text LIKE '%' || $3::text || '%'
              FOR UPDATE OF o)
         UPDATE scheduled_transaction_overrides o
            SET splits = replace(old.splits::text, '"' || $3::text || '"', $1::text)::jsonb
           FROM old
          WHERE o.id = old.id
      RETURNING o.id, old.splits AS before, o.splits AS after`,
        [
          toCategoryId ? JSON.stringify(toCategoryId) : "null",
          userId,
          fromCategoryId,
        ],
      ),
    );

    return {
      transactionsUpdated: transactions.length,
      splitsUpdated: transactionSplits.length,
      scheduledUpdated: scheduled.length,
      moved: {
        to: toCategoryId,
        transactions,
        transactionSplits,
        scheduled,
        scheduledSplits,
        overrides,
        overrideSplits,
      },
    };
  }

  async getStats(userId: string): Promise<{
    totalCategories: number;
    incomeCategories: number;
    expenseCategories: number;
    transferCategories: number;
    subcategories: number;
  }> {
    const categories = await this.findAll(userId, false);

    const incomeCategories = categories.filter(isIncomeCategory).length;
    const expenseCategories = categories.filter(isExpenseCategory).length;
    const transferCategories = categories.filter(isTransferCategory).length;
    const subcategories = categories.filter((c) => c.parentId !== null).length;

    return {
      totalCategories: categories.length,
      incomeCategories,
      expenseCategories,
      transferCategories,
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
    const { income, expense, transfer } = getDefaultCategories(options.country);

    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(Category);
      let categoryCount = 0;

      const branches: ReadonlyArray<readonly [CategoryType, typeof income]> = [
        ["income", income],
        ["expense", expense],
        ["transfer", transfer],
      ];
      for (const [type, definitions] of branches) {
        for (const cat of definitions) {
          const savedParent = await repo.save(
            repo.create({
              userId,
              name: localizeCategory(cat.name),
              categoryType: type,
            }),
          );
          categoryCount++;

          for (const subName of cat.subcategories) {
            await repo.save(
              repo.create({
                userId,
                parentId: savedParent.id,
                name: localizeSubcategory(cat.name, subName),
                categoryType: type,
              }),
            );
            categoryCount++;
          }
        }
      }

      return { categoriesCreated: categoryCount };
    });
  }
}

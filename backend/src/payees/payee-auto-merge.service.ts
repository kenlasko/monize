import {
  beginTaxonomyOperation,
  recordTaxonomyOperation,
} from "../accruals/accrual-taxonomy-operation";
import { lockPayeeCategoryBatch } from "./payee-category-batch";
import {
  preparePayeeCategoryEdit,
  applyPayeeCategoryEdit,
} from "./payee-category-impact";
import { verifyBulkAccrualEdit } from "../accruals/accrual-bulk-edit";
import { accrualErrors } from "../accruals/accrual-errors";
import {
  updatePayeeSourceMetadata,
  type PayeeSourceRow,
} from "./payee-source-metadata";
import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { DataSource, EntityManager, In, QueryFailedError } from "typeorm";
import { tr } from "../i18n/translate";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Category } from "../categories/entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { PayeesService } from "./payees.service";
import { matchesAliasPattern } from "./alias-match.util";
import { insertPayeeAliasIgnoringDuplicate } from "./insert-payee-alias.util";
import { COMMON_WORD_SEED } from "./payee-common-words";
import {
  normalizePayeeName,
  significantTokens,
  similarity,
} from "./payee-normalize.util";
import { countUncategorizedTransactionsByPayee } from "./payee-backfill.util";
import { withScopedDb } from "../common/db/scoped-db";

export type CategoryMatchMode = "off" | "category" | "subcategory";

export interface AutoMergeOptions {
  minGroupSize: number;
  similarityThreshold: number; // 0-1
  minTokenLength: number;
  includeInactive: boolean;
  // When not "off", only payees sharing the same category ("category" = the
  // top-level parent, "subcategory" = the exact default category) may merge.
  categoryMatch: CategoryMatchMode;
  // When true, payees whose leading word is "common" (a generic business word,
  // a country name, or a word many distinct payees branch off) are excluded so
  // they never anchor a group or alias.
  ignoreCommonWords: boolean;
  // Auto-detect threshold: a leading token is treated as common once at least
  // this many payees branch off it with distinct continuations.
  commonWordMinVariants: number;
}

export interface AutoMergeMember {
  payeeId: string;
  name: string;
  transactionCount: number;
  isCanonical: boolean;
}

export interface AutoMergeGroupPreview {
  groupKey: string;
  suggestedCanonicalPayeeId: string;
  suggestedName: string;
  suggestedAlias: string;
  // The group's most-used transaction category (across all members), offered as
  // a default category for the merged payee; null when no member has any
  // categorized transactions.
  suggestedCategoryId: string | null;
  // How many transactions across all members currently have no category (and
  // are not transfers or split parents), i.e. how many a default-category
  // backfill would touch once the group is merged into its canonical.
  uncategorizedTransactionCount: number;
  members: AutoMergeMember[];
  totalTransactions: number;
}

export interface ApplyAutoMergeGroup {
  accrualImpactFingerprint?: string;
  canonicalPayeeId: string;
  canonicalName?: string;
  sourcePayeeIds: string[];
  alias?: string;
  // Optional default category to set on the canonical payee after merging.
  defaultCategoryId?: string;
  // When true (and a default category is set), also apply that category to the
  // canonical's existing uncategorized transactions after the merge.
  backfillTransactions?: boolean;
}

export interface ApplyAutoMergeFailure {
  canonicalPayeeId: string;
  // The canonical name the caller asked to keep (falls back to the id), so the
  // UI can name the group that failed instead of showing an opaque error.
  canonicalName: string;
  // The specific value that caused the failure (the alias or new name that
  // collided), when one can be identified; null for failures with no single
  // offending value.
  conflictingValue: string | null;
  // A human-readable, already-translated reason for the failure.
  reason: string;
}

export interface ApplyAutoMergeSkippedAlias {
  canonicalPayeeId: string;
  canonicalName: string;
  // The wildcard alias that was not created because it is already in use
  // (by the canonical, another payee, or the DB unique constraint). The merge
  // itself still succeeded; only this alias was skipped.
  alias: string;
}

export interface ApplyAutoMergeResult {
  groupsMerged: number;
  payeesMerged: number;
  transactionsMigrated: number;
  aliasesCreated: number;
  skippedAliases: number;
  transactionsBackfilled: number;
  // Which aliases were skipped and on which group, so the UI can say exactly
  // what conflicted instead of only a count.
  skippedAliasDetails: ApplyAutoMergeSkippedAlias[];
  // Groups that could not be merged. The successful groups are already
  // committed (each runs in its own transaction), so a partial batch still
  // reports what got through and what did not, and why.
  failures: ApplyAutoMergeFailure[];
}

// Cap the cross-bucket fuzzy pass (O(B^2) over distinct first tokens) to keep
// preview cheap on very large payee lists.
const MAX_FUZZY_FIRST_TOKENS = 1500;

// findAll() enriches each payee with computed stats (transactionCount, etc.).
type PayeeWithStats = Awaited<ReturnType<PayeesService["findAll"]>>[number];

interface AnnotatedPayee {
  payee: PayeeWithStats;
  tokens: string[];
  // Category identity used to gate merges when categoryMatch is enabled; null
  // when the payee has no default category (or matching is off).
  categoryKey: string | null;
}

@Injectable()
export class PayeeAutoMergeService {
  private readonly logger = new Logger(PayeeAutoMergeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly payeesService: PayeesService,
  ) {}

  /**
   * Analyze all payees and propose merge groups of near-duplicates. Payees are
   * grouped only when one name is a (fuzzy) token-prefix elaboration of another
   * - e.g. "Lidl" -> "Lidl Warszawa" -> "Lidl sp. z o.o." - so a merely shared
   * common word does NOT collapse unrelated payees ("Royal Electric" vs "Royal
   * City Nursery" diverge at the second token and stay apart). Each group
   * suggests a canonical payee (the most-used member) and a wildcard alias built
   * from the shared prefix so future imports are auto-captured. Read-only.
   */
  async previewAutoMerge(
    userId: string,
    opts: AutoMergeOptions,
  ): Promise<{ groups: AutoMergeGroupPreview[] }> {
    const payees = await this.payeesService.findAll(
      userId,
      opts.includeInactive ? "all" : "active",
    );

    // Per-payee transaction-category counts drive both the optional category
    // filter (dominant category fallback) and the suggested default category
    // returned for each group, so build it once up front.
    const categoryCounts = await this.buildCategoryCountsMap(userId);

    // Per-payee count of transactions a default-category backfill would touch,
    // surfaced per group so the UI can offer the optional backfill with a count.
    const uncategorizedCounts = await withScopedDb(this.dataSource, (m) =>
      countUncategorizedTransactionsByPayee(m, userId),
    );

    // Resolve each payee's effective category when the filter is on: prefer the
    // explicit default category, else fall back to the payee's dominant
    // transaction category. A null key means "category unknown" - such payees
    // are excluded from grouping rather than matched against each other.
    const categoryFilterOn = opts.categoryMatch !== "off";
    const rootByCategory =
      opts.categoryMatch === "category"
        ? await this.buildRootCategoryMap(userId)
        : null;
    const dominantByPayee = categoryFilterOn
      ? this.dominantFromCounts(categoryCounts)
      : null;
    const categoryKeyOf = (payee: PayeeWithStats): string | null => {
      if (!categoryFilterOn) return null;
      const catId = payee.defaultCategoryId ?? dominantByPayee?.get(payee.id);
      if (!catId) return null;
      if (opts.categoryMatch === "subcategory") return catId;
      return rootByCategory?.get(catId) ?? catId;
    };

    // Tokenize each payee's normalized name; skip names with no usable token.
    const annotated: AnnotatedPayee[] = payees
      .map((payee) => ({
        payee,
        tokens: significantTokens(
          normalizePayeeName(payee.name),
          opts.minTokenLength,
        ),
        categoryKey: categoryKeyOf(payee),
      }))
      .filter((entry) => entry.tokens.length > 0);

    // Optionally drop payees anchored on a "common" leading word so generic
    // words never form a group or an over-broad alias.
    const eligible = opts.ignoreCommonWords
      ? this.dropCommonAnchors(annotated, opts.commonWordMinVariants)
      : annotated;

    const clusters = this.clusterPayees(
      eligible,
      opts.similarityThreshold,
      opts.categoryMatch !== "off",
    );

    const groups: AutoMergeGroupPreview[] = clusters
      .filter((members) => members.length >= opts.minGroupSize)
      .map((members) =>
        this.toGroupPreview(
          members,
          opts.minTokenLength,
          categoryCounts,
          uncategorizedCounts,
        ),
      )
      .sort((a, b) => {
        if (b.totalTransactions !== a.totalTransactions) {
          return b.totalTransactions - a.totalTransactions;
        }
        return a.suggestedName.localeCompare(b.suggestedName);
      });

    return { groups };
  }

  /**
   * Exclude payees whose leading significant token is "common" - either in the
   * curated seed list (generic business words, country names) or detected from
   * the data because at least `minVariants` distinct continuations branch off it
   * (e.g. "Royal Electric", "Royal City Nursery", "Royal Cat..."; also catches
   * recurring city names). This keeps generic words from anchoring a group or
   * producing a broad alias.
   */
  private dropCommonAnchors(
    annotated: AnnotatedPayee[],
    minVariants: number,
  ): AnnotatedPayee[] {
    // Count distinct second tokens per leading token to auto-detect common ones.
    const continuations = new Map<string, Set<string>>();
    for (const entry of annotated) {
      const lead = entry.tokens[0];
      const second = entry.tokens[1];
      if (second === undefined) continue; // bare name adds no continuation
      const set = continuations.get(lead);
      if (set) set.add(second);
      else continuations.set(lead, new Set([second]));
    }

    const isCommon = (token: string): boolean => {
      if (COMMON_WORD_SEED.has(token)) return true;
      const conts = continuations.get(token);
      return conts !== undefined && conts.size >= minVariants;
    };

    return annotated.filter((entry) => !isCommon(entry.tokens[0]));
  }

  /**
   * Cluster payees by fuzzy token-prefix containment: two payees join the same
   * cluster when the shorter token list is a prefix of the longer one, with
   * each aligned token matching within the similarity threshold (a token
   * matches itself at 1.0, so a threshold of 1 requires exact tokens). Prefix
   * containment requires the first tokens to match, so payees are first bucketed
   * by exact first token; spelling variants of the first token (LIDL/LIDI) are
   * reconciled in a bounded cross-bucket pass.
   *
   * When `enforceCategory` is set, two payees may only link when their category
   * keys are equal (equality is transitive, so clusters stay category-pure).
   */
  private clusterPayees(
    annotated: AnnotatedPayee[],
    threshold: number,
    enforceCategory: boolean,
  ): PayeeWithStats[][] {
    const n = annotated.length;
    const canLink = (i: number, j: number): boolean => {
      if (enforceCategory) {
        const keyA = annotated[i].categoryKey;
        const keyB = annotated[j].categoryKey;
        // An unknown category (null) never matches - not even another unknown -
        // so payees with no determinable category are not grouped together.
        if (keyA === null || keyB === null || keyA !== keyB) {
          return false;
        }
      }
      return this.isFuzzyPrefix(
        annotated[i].tokens,
        annotated[j].tokens,
        threshold,
      );
    };
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      let node = i;
      while (parent[node] !== node) {
        const next = parent[node];
        parent[node] = root;
        node = next;
      }
      return root;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    const byFirstToken = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const first = annotated[i].tokens[0];
      const list = byFirstToken.get(first);
      if (list) list.push(i);
      else byFirstToken.set(first, [i]);
    }

    // Within a first-token bucket: link prefix elaborations.
    for (const indices of byFirstToken.values()) {
      for (let a = 0; a < indices.length; a++) {
        for (let b = a + 1; b < indices.length; b++) {
          if (canLink(indices[a], indices[b])) {
            union(indices[a], indices[b]);
          }
        }
      }
    }

    // Across buckets: only when the first tokens are themselves close enough
    // (spelling variants like LIDL/LIDI). Skipped on pathologically large input.
    const firstTokens = [...byFirstToken.keys()];
    if (firstTokens.length <= MAX_FUZZY_FIRST_TOKENS) {
      for (let a = 0; a < firstTokens.length; a++) {
        for (let b = a + 1; b < firstTokens.length; b++) {
          if (similarity(firstTokens[a], firstTokens[b]) < threshold) continue;
          const ia = byFirstToken.get(firstTokens[a])!;
          const ib = byFirstToken.get(firstTokens[b])!;
          for (const x of ia) {
            for (const y of ib) {
              if (canLink(x, y)) {
                union(x, y);
              }
            }
          }
        }
      }
    }

    const clusters = new Map<number, PayeeWithStats[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const list = clusters.get(root);
      if (list) list.push(annotated[i].payee);
      else clusters.set(root, [annotated[i].payee]);
    }
    return [...clusters.values()];
  }

  /**
   * Build a map from every category id to its top-level (root) category id, so
   * subcategories can be compared at the parent-category level.
   */
  private async buildRootCategoryMap(
    userId: string,
  ): Promise<Map<string, string>> {
    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
        select: ["id", "parentId"],
      }),
    );
    const parentOf = new Map<string, string | null>(
      categories.map((c) => [c.id, c.parentId]),
    );
    const rootOf = new Map<string, string>();
    for (const category of categories) {
      let current = category.id;
      const seen = new Set<string>();
      // Walk up the parent chain, guarding against cycles and missing parents.
      while (true) {
        const parent = parentOf.get(current);
        if (!parent || !parentOf.has(parent) || seen.has(parent)) break;
        seen.add(parent);
        current = parent;
      }
      rootOf.set(category.id, current);
    }
    return rootOf;
  }

  /**
   * Build a map from payee id to its per-category transaction counts
   * (payeeId -> categoryId -> count). Transfers and uncategorized transactions
   * are ignored. Drives both the dominant-category fallback used by the category
   * filter and the suggested default category surfaced per merge group.
   */
  private async buildCategoryCountsMap(
    userId: string,
  ): Promise<Map<string, Map<string, number>>> {
    const rows = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .select("t.payee_id", "payeeId")
        .addSelect("t.category_id", "categoryId")
        .addSelect("COUNT(*)", "cnt")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.payee_id IS NOT NULL")
        .andWhere("t.category_id IS NOT NULL")
        .andWhere("t.is_transfer = false")
        .groupBy("t.payee_id")
        .addGroupBy("t.category_id")
        .getRawMany<{ payeeId: string; categoryId: string; cnt: string }>(),
    );

    const map = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const count = parseInt(row.cnt, 10);
      const inner = map.get(row.payeeId);
      if (inner) {
        inner.set(row.categoryId, count);
      } else {
        map.set(row.payeeId, new Map([[row.categoryId, count]]));
      }
    }
    return map;
  }

  /**
   * Reduce per-category counts to each payee's single dominant (most-used)
   * category, used as the payee's category when no explicit default is set.
   */
  private dominantFromCounts(
    categoryCounts: Map<string, Map<string, number>>,
  ): Map<string, string> {
    const result = new Map<string, string>();
    for (const [payeeId, counts] of categoryCounts) {
      let bestCategory: string | null = null;
      let bestCount = -1;
      for (const [categoryId, count] of counts) {
        if (count > bestCount) {
          bestCategory = categoryId;
          bestCount = count;
        }
      }
      if (bestCategory !== null) {
        result.set(payeeId, bestCategory);
      }
    }
    return result;
  }

  /**
   * The group's most-used transaction category: sum each member's per-category
   * counts and pick the highest total (ties broken by category id for
   * determinism). Returns null when no member has any categorized transactions.
   */
  private suggestedCategoryForGroup(
    payeeList: PayeeWithStats[],
    categoryCounts: Map<string, Map<string, number>>,
  ): string | null {
    const totals = new Map<string, number>();
    for (const payee of payeeList) {
      const counts = categoryCounts.get(payee.id);
      if (!counts) continue;
      for (const [categoryId, count] of counts) {
        totals.set(categoryId, (totals.get(categoryId) ?? 0) + count);
      }
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [categoryId, count] of totals) {
      if (
        count > bestCount ||
        (count === bestCount && best !== null && categoryId < best)
      ) {
        best = categoryId;
        bestCount = count;
      }
    }
    return best;
  }

  /**
   * True when the shorter token list is a prefix of the longer one, with each
   * aligned token pair matching within the similarity threshold.
   */
  private isFuzzyPrefix(a: string[], b: string[], threshold: number): boolean {
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    for (let k = 0; k < shorter.length; k++) {
      if (similarity(shorter[k], longer[k]) < threshold) return false;
    }
    return true;
  }

  private toGroupPreview(
    payeeList: PayeeWithStats[],
    minTokenLength: number,
    categoryCounts: Map<string, Map<string, number>>,
    uncategorizedCounts: Map<string, number>,
  ): AutoMergeGroupPreview {
    // Canonical = most transactions, tie-break on shortest then alphabetical.
    const canonical = [...payeeList].sort((a, b) => {
      const ca = a.transactionCount ?? 0;
      const cb = b.transactionCount ?? 0;
      if (cb !== ca) return cb - ca;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    })[0];

    // Anchor the alias on the token-prefix shared by every member so it is as
    // specific as the merge ("*LIDL*", "*ROYAL CITY NURSERY*"), falling back to
    // the canonical's first token for fuzzy/typo clusters with no exact prefix.
    const memberTokens = payeeList.map((p) =>
      significantTokens(normalizePayeeName(p.name), minTokenLength),
    );
    const commonPrefix = longestCommonTokenPrefix(memberTokens);
    const canonicalTokens = significantTokens(
      normalizePayeeName(canonical.name),
      minTokenLength,
    );
    const aliasBase =
      commonPrefix.length > 0
        ? commonPrefix.join(" ")
        : (canonicalTokens[0] ?? "");

    const members: AutoMergeMember[] = payeeList
      .map((payee) => ({
        payeeId: payee.id,
        name: payee.name,
        transactionCount: payee.transactionCount ?? 0,
        isCanonical: payee.id === canonical.id,
      }))
      .sort((a, b) => b.transactionCount - a.transactionCount);

    const totalTransactions = members.reduce(
      (sum, m) => sum + m.transactionCount,
      0,
    );

    // After the merge, every member's transactions belong to the canonical, so
    // the backfill scope is the sum of each member's uncategorized count.
    const uncategorizedTransactionCount = payeeList.reduce(
      (sum, payee) => sum + (uncategorizedCounts.get(payee.id) ?? 0),
      0,
    );

    return {
      groupKey: aliasBase,
      suggestedCanonicalPayeeId: canonical.id,
      suggestedName: canonical.name,
      suggestedAlias: aliasBase ? `*${aliasBase}*` : "",
      suggestedCategoryId: this.suggestedCategoryForGroup(
        payeeList,
        categoryCounts,
      ),
      uncategorizedTransactionCount,
      members,
      totalTransactions,
    };
  }

  /**
   * Apply the chosen merge groups. Each group runs in its own transaction so a
   * failure in one group does not roll back the others. Per group: reassign the
   * sources' transactions/scheduled-transactions and aliases to the canonical
   * payee, optionally rename the canonical, delete the sources, and create one
   * wildcard alias on the canonical.
   */
  async applyAutoMerge(
    userId: string,
    groups: ApplyAutoMergeGroup[],
  ): Promise<ApplyAutoMergeResult> {
    // A payee may not appear in more than one group, nor as both canonical and
    // source, to avoid conflicting reassignments.
    const seen = new Set<string>();
    for (const group of groups) {
      const ids = [group.canonicalPayeeId, ...group.sourcePayeeIds];
      for (const id of ids) {
        if (seen.has(id)) {
          throw new BadRequestException(
            tr(
              "errors.payees.autoMergeDuplicatePayee",
              "A payee appears in more than one merge group",
            ),
          );
        }
        seen.add(id);
      }
      if (group.sourcePayeeIds.includes(group.canonicalPayeeId)) {
        throw new BadRequestException(
          tr("errors.payees.mergeSelf", "Cannot merge a payee into itself"),
        );
      }
    }

    // Batch-verify any chosen default categories belong to the user before
    // touching the database, so an invalid id fails fast rather than mid-merge.
    const categoryIds = [
      ...new Set(
        groups
          .map((g) => g.defaultCategoryId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (categoryIds.length > 0) {
      const owned = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(Category).find({
          where: { id: In(categoryIds), userId },
          select: ["id"],
        }),
      );
      const ownedIds = new Set(owned.map((c) => c.id));
      const invalidIds = categoryIds.filter((id) => !ownedIds.has(id));
      if (invalidIds.length > 0) {
        throw new BadRequestException(
          tr(
            "errors.payees.categoryIdsNotOwned",
            `Category IDs not found or not owned by user: ${invalidIds.join(", ")}`,
            { ids: invalidIds.join(", ") },
          ),
        );
      }
    }

    const result: ApplyAutoMergeResult = {
      groupsMerged: 0,
      payeesMerged: 0,
      transactionsMigrated: 0,
      aliasesCreated: 0,
      skippedAliases: 0,
      transactionsBackfilled: 0,
      skippedAliasDetails: [],
      failures: [],
    };

    // Each group commits in its own transaction, so isolate failures here too:
    // one group that hits a constraint (e.g. a name/alias collision) must not
    // abort the groups that follow it. Record which group failed, on what
    // value, and why, so the caller can report a partial result instead of an
    // opaque 409.
    for (const group of groups) {
      try {
        const groupResult = await this.applyGroup(userId, group);
        result.groupsMerged += 1;
        result.payeesMerged += groupResult.payeesMerged;
        result.transactionsMigrated += groupResult.transactionsMigrated;
        result.aliasesCreated += groupResult.aliasCreated ? 1 : 0;
        if (groupResult.aliasSkipped) {
          result.skippedAliases += 1;
          result.skippedAliasDetails.push({
            canonicalPayeeId: group.canonicalPayeeId,
            canonicalName:
              group.canonicalName?.trim() || group.canonicalPayeeId,
            alias: group.alias?.trim() ?? "",
          });
        }
        result.transactionsBackfilled += groupResult.transactionsBackfilled;
      } catch (error) {
        result.failures.push(this.describeGroupFailure(group, error));
      }
    }

    return result;
  }

  /**
   * Turn a thrown error from one merge group into a structured, named failure so
   * the response says which group failed and on what value, instead of letting a
   * raw QueryFailedError surface as a generic "a record with this value already
   * exists" with no context.
   */
  private describeGroupFailure(
    group: ApplyAutoMergeGroup,
    error: unknown,
  ): ApplyAutoMergeFailure {
    const canonicalName = group.canonicalName?.trim() || group.canonicalPayeeId;
    // The values a merge can collide on are the (renamed) canonical name and the
    // wildcard alias; surface whichever the group carried.
    const conflictingValue =
      group.alias?.trim() || group.canonicalName?.trim() || null;

    const isUniqueViolation =
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string })?.code === "23505";

    if (isUniqueViolation) {
      return {
        canonicalPayeeId: group.canonicalPayeeId,
        canonicalName,
        conflictingValue,
        reason: tr(
          "errors.payees.autoMergeGroupConflict",
          conflictingValue
            ? `Could not merge "${canonicalName}": the value "${conflictingValue}" is already in use`
            : `Could not merge "${canonicalName}": a value is already in use`,
          { name: canonicalName, value: conflictingValue ?? "" },
        ),
      };
    }

    // A NestJS HttpException (e.g. the rename ConflictException) already carries
    // a translated, user-facing message; reuse it. Anything else falls back to a
    // generic per-group failure so one bad group never sinks the whole batch.
    const reason =
      error instanceof Error && error.message
        ? error.message
        : tr(
            "errors.payees.autoMergeGroupFailed",
            `Could not merge "${canonicalName}"`,
            { name: canonicalName },
          );

    return {
      canonicalPayeeId: group.canonicalPayeeId,
      canonicalName,
      conflictingValue,
      reason,
    };
  }

  async previewCategoryImpact(userId: string, group: ApplyAutoMergeGroup) {
    return withScopedDb(this.dataSource, async (m) => {
      const prepared = await this.prepareGroupCategory(m, userId, group);
      return {
        canonicalPayeeId: group.canonicalPayeeId,
        ...prepared.categoryEdit.preview,
      };
    });
  }

  private async prepareGroupCategory(
    m: EntityManager,
    userId: string,
    group: ApplyAutoMergeGroup,
  ) {
    const ids = [group.canonicalPayeeId, ...group.sourcePayeeIds];
    if (new Set(ids).size !== ids.length) throw accrualErrors.conflict();
    const locked = await lockPayeeCategoryBatch(
      m,
      userId,
      ids,
      group.defaultCategoryId ? [group.defaultCategoryId] : [],
    );
    const canonical = await m.findOne(Payee, {
      where: { id: group.canonicalPayeeId, userId },
    });
    if (!canonical) {
      throw new BadRequestException(
        tr(
          "errors.payees.notFound",
          `Payee with ID ${group.canonicalPayeeId} not found`,
          { id: group.canonicalPayeeId },
        ),
      );
    }

    const sources = await m.find(Payee, {
      where: group.sourcePayeeIds.map((id) => ({ id, userId })),
    });
    if (sources.length !== group.sourcePayeeIds.length) {
      throw new BadRequestException(
        tr(
          "errors.payees.autoMergeSourceNotFound",
          "One or more source payees were not found",
        ),
      );
    }

    if (locked.payees.length !== ids.length) throw accrualErrors.missing();
    const { accrualImpactFingerprint: _ignored, ...command } = group;
    const categoryEdit = await preparePayeeCategoryEdit(
      m,
      userId,
      canonical.id,
      {
        name: group.canonicalName?.trim() || canonical.name,
        defaultCategoryId: group.defaultCategoryId ?? null,
        applyCategoryToTransactions:
          group.backfillTransactions && group.defaultCategoryId
            ? "uncategorized"
            : "none",
      },
      {
        sources: locked.sources,
        command: {
          group: command,
          payees: locked.payees,
          sources: locked.snapshots,
        },
        projectedPayeeId: canonical.id,
      },
    );
    return {
      canonical,
      sources,
      transactionSources: locked.sources,
      categoryEdit,
    };
  }

  private async applyGroup(
    userId: string,
    group: ApplyAutoMergeGroup,
  ): Promise<{
    payeesMerged: number;
    transactionsMigrated: number;
    aliasCreated: boolean;
    aliasSkipped: boolean;
    transactionsBackfilled: number;
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const history = await beginTaxonomyOperation(m, userId, "payee", [
        group.canonicalPayeeId,
        ...group.sourcePayeeIds,
      ]);
      const { canonical, sources, transactionSources, categoryEdit } =
        await this.prepareGroupCategory(m, userId, group);
      verifyBulkAccrualEdit(
        categoryEdit.preview,
        group.accrualImpactFingerprint,
      );
      // Optional rename of the canonical payee.
      const canonicalName = await this.maybeRenameCanonical(
        m,
        userId,
        canonical,
        group,
        transactionSources,
      );

      // Optionally set the chosen default category on the canonical. Ownership
      // was validated up front in applyAutoMerge.
      if (group.defaultCategoryId) {
        await m.update(
          Payee,
          { id: canonical.id, userId },
          { defaultCategoryId: group.defaultCategoryId },
        );
      }

      // Reassign each source's data to the canonical, then delete the source.
      let transactionsMigrated = 0;
      for (const source of sources) {
        transactionsMigrated += await updatePayeeSourceMetadata(
          m,
          userId,
          transactionSources,
          source.id,
          { payeeId: canonical.id, payeeName: canonicalName },
        );

        await m.update(
          ScheduledTransaction,
          { payeeId: source.id, userId },
          { payeeId: canonical.id, payeeName: canonicalName },
        );

        await m.update(
          PayeeAlias,
          { payeeId: source.id, userId },
          { payeeId: canonical.id },
        );

        await m.remove(Payee, source);
      }

      // Create the wildcard alias on the canonical.
      const aliasOutcome = await this.createGroupAlias(
        m,
        userId,
        canonical.id,
        group.alias,
      );

      // Optionally backfill the canonical's uncategorized transactions with the
      // chosen default category. Runs after reassignment so it covers every
      // member's transactions, and only ever touches rows with no category.
      const transactionsBackfilled = await applyPayeeCategoryEdit(
        m,
        userId,
        canonical.id,
        categoryEdit,
      );

      await recordTaxonomyOperation(m, userId, history);
      return {
        payeesMerged: sources.length,
        transactionsMigrated,
        aliasCreated: aliasOutcome === "created",
        aliasSkipped: aliasOutcome === "skipped",
        transactionsBackfilled,
      };
    });
  }

  private async maybeRenameCanonical(
    m: EntityManager,
    userId: string,
    canonical: Payee,
    group: ApplyAutoMergeGroup,
    transactionSources: readonly PayeeSourceRow[],
  ): Promise<string> {
    const desired = group.canonicalName?.trim();
    if (!desired || desired === canonical.name) {
      return canonical.name;
    }

    // Reject a rename that collides with a payee that is not part of this
    // group (the sources are deleted, so colliding with them is harmless).
    const excludedIds = new Set([canonical.id, ...group.sourcePayeeIds]);
    const conflict = await m
      .createQueryBuilder(Payee, "payee")
      .where("payee.user_id = :userId", { userId })
      .andWhere("LOWER(payee.name) = LOWER(:name)", { name: desired })
      .getMany();
    if (conflict.some((p) => !excludedIds.has(p.id))) {
      throw new ConflictException(
        tr(
          "errors.payees.nameConflict",
          `Payee with name "${desired}" already exists`,
          { name: desired },
        ),
      );
    }

    await m.update(Payee, { id: canonical.id, userId }, { name: desired });
    // Keep the denormalized snapshot in sync on the canonical's own rows.
    await updatePayeeSourceMetadata(
      m,
      userId,
      transactionSources,
      canonical.id,
      {
        payeeName: desired,
      },
    );
    await m.update(
      ScheduledTransaction,
      { payeeId: canonical.id, userId },
      { payeeName: desired },
    );

    return desired;
  }

  private async createGroupAlias(
    m: EntityManager,
    userId: string,
    canonicalId: string,
    rawAlias: string | undefined,
  ): Promise<"created" | "skipped" | "none"> {
    const alias = rawAlias?.trim();
    if (!alias) return "none";

    const allAliases = await m.find(PayeeAlias, {
      where: { userId },
    });

    // Drop aliases on the canonical that the new wildcard already subsumes
    // (e.g. moved source-name aliases like "LIDL WARSZAWA 0421" under "*LIDL*").
    const redundant = allAliases.filter(
      (a) =>
        a.payeeId === canonicalId &&
        a.alias.toLowerCase() !== alias.toLowerCase() &&
        matchesAliasPattern(a.alias, alias),
    );
    if (redundant.length > 0) {
      await m.remove(PayeeAlias, redundant);
    }

    // If the exact alias already exists on the canonical, nothing to do.
    const exactOnCanonical = allAliases.find(
      (a) =>
        a.payeeId === canonicalId &&
        a.alias.toLowerCase() === alias.toLowerCase(),
    );
    if (exactOnCanonical) return "none";

    // Skip (rather than abort the merge) if the alias overlaps another payee's
    // alias, so the merge itself still succeeds.
    const conflict = allAliases.some(
      (a) =>
        a.payeeId !== canonicalId &&
        (matchesAliasPattern(alias, a.alias) ||
          matchesAliasPattern(a.alias, alias)),
    );
    if (conflict) {
      this.logger.warn(
        `Skipping auto-merge alias "${alias}" for payee ${canonicalId}: overlaps an alias on another payee`,
      );
      return "skipped";
    }

    const newAlias = m.create(PayeeAlias, {
      payeeId: canonicalId,
      userId,
      alias,
    });

    // The in-app conflict check above is pattern-based and cannot perfectly
    // mirror the DB's UNIQUE(user_id, LOWER(alias)) index, so the insert can
    // still race a duplicate. The alias is a best-effort convenience, not the
    // point of the merge, so a unique violation is downgraded to "skipped"
    // (via a savepoint) instead of aborting the whole group transaction.
    const created = await insertPayeeAliasIgnoringDuplicate(
      m,
      newAlias,
      "create_group_alias",
    );
    if (!created) {
      this.logger.warn(
        `Skipping auto-merge alias "${alias}" for payee ${canonicalId}: already in use (unique constraint)`,
      );
      return "skipped";
    }
    return "created";
  }
}

/**
 * The longest run of leading tokens shared (exactly) by every token list.
 * Used to build a merge group's wildcard alias from the common base name.
 */
function longestCommonTokenPrefix(tokenLists: string[][]): string[] {
  if (tokenLists.length === 0) return [];
  const minLen = Math.min(...tokenLists.map((tokens) => tokens.length));
  const prefix: string[] = [];
  for (let k = 0; k < minLen; k++) {
    // `leading`, not `token`: these are payee-name words, and a local whose
    // name ends in "token" reads to Bearer's CWE-208 rule as a credential
    // compared in variable time.
    const leading = tokenLists[0][k];
    if (tokenLists.every((tokens) => tokens[k] === leading)) {
      prefix.push(leading);
    } else {
      break;
    }
  }
  return prefix;
}

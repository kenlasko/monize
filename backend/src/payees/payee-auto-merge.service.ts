import {
  Injectable,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { DataSource, QueryRunner } from "typeorm";
import { tr } from "../i18n/translate";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { PayeesService } from "./payees.service";
import { matchesAliasPattern } from "./alias-match.util";
import {
  normalizePayeeName,
  leadingSignificantToken,
  similarity,
} from "./payee-normalize.util";

export interface AutoMergeOptions {
  minGroupSize: number;
  similarityThreshold: number; // 0-1
  minTokenLength: number;
  includeInactive: boolean;
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
  members: AutoMergeMember[];
  totalTransactions: number;
}

export interface ApplyAutoMergeGroup {
  canonicalPayeeId: string;
  canonicalName?: string;
  sourcePayeeIds: string[];
  alias?: string;
}

export interface ApplyAutoMergeResult {
  groupsMerged: number;
  payeesMerged: number;
  transactionsMigrated: number;
  aliasesCreated: number;
  skippedAliases: number;
}

// Cap the fuzzy O(G^2) representative comparison to keep preview cheap even
// for very large payee lists. Token bucketing still applies above this.
const MAX_FUZZY_GROUPS = 1500;

// findAll() enriches each payee with computed stats (transactionCount, etc.).
type PayeeWithStats = Awaited<ReturnType<PayeesService["findAll"]>>[number];

interface Cluster {
  token: string;
  payees: PayeeWithStats[];
}

@Injectable()
export class PayeeAutoMergeService {
  private readonly logger = new Logger(PayeeAutoMergeService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly payeesService: PayeesService,
  ) {}

  /**
   * Analyze all payees and propose merge groups of near-duplicates. Each group
   * suggests a canonical payee (the most-used member) and a wildcard alias
   * (`*TOKEN*`) so future imports are auto-captured. Read-only.
   */
  async previewAutoMerge(
    userId: string,
    opts: AutoMergeOptions,
  ): Promise<{ groups: AutoMergeGroupPreview[] }> {
    const payees = await this.payeesService.findAll(
      userId,
      opts.includeInactive ? "all" : "active",
    );

    // Precompute normalized form + leading token for each payee.
    const annotated = payees
      .map((payee) => ({
        payee,
        normalized: normalizePayeeName(payee.name),
      }))
      .map((entry) => ({
        ...entry,
        token: leadingSignificantToken(entry.normalized, opts.minTokenLength),
      }))
      .filter(
        (
          entry,
        ): entry is {
          payee: PayeeWithStats;
          normalized: string;
          token: string;
        } => entry.token !== null,
      );

    // Stage 1: bucket by leading significant token.
    const buckets = new Map<string, Cluster>();
    for (const entry of annotated) {
      const existing = buckets.get(entry.token);
      if (!existing) {
        buckets.set(entry.token, {
          token: entry.token,
          payees: [entry.payee],
        });
      } else {
        buckets.set(entry.token, {
          ...existing,
          payees: [...existing.payees, entry.payee],
        });
      }
    }

    // Stage 2: fuzzy-merge buckets whose leading tokens are close enough so
    // spelling variants that fell into different token buckets still group
    // (e.g. LIDL/LIDI, WALMART/WALMRT). Exact-token buckets are already merged
    // in Stage 1; this is where the similarity threshold takes effect.
    const clusters = this.fuzzyMergeClusters(
      [...buckets.values()],
      opts.similarityThreshold,
    );

    // Build previews for clusters that meet the minimum group size.
    const groups: AutoMergeGroupPreview[] = clusters
      .filter((cluster) => cluster.payees.length >= opts.minGroupSize)
      .map((cluster) => this.toGroupPreview(cluster, opts.minTokenLength))
      .sort((a, b) => {
        if (b.totalTransactions !== a.totalTransactions) {
          return b.totalTransactions - a.totalTransactions;
        }
        return a.suggestedName.localeCompare(b.suggestedName);
      });

    return { groups };
  }

  private fuzzyMergeClusters(
    clusters: Cluster[],
    threshold: number,
  ): Cluster[] {
    // Skip the quadratic pass on pathologically large inputs.
    if (clusters.length > MAX_FUZZY_GROUPS) return clusters;

    // Union-find over cluster indices.
    const parent = clusters.map((_, i) => i);
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

    // Compare leading tokens (not full names): a token matches itself at 1.0,
    // so a threshold of 1 means "exact tokens only" while lower values pull in
    // near-token spelling variants.
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (find(i) === find(j)) continue;
        if (similarity(clusters[i].token, clusters[j].token) >= threshold) {
          union(i, j);
        }
      }
    }

    const merged = new Map<number, Cluster>();
    for (let i = 0; i < clusters.length; i++) {
      const root = find(i);
      const current = clusters[i];
      const existing = merged.get(root);
      if (!existing) {
        merged.set(root, current);
      } else {
        // Keep the token of the larger contributing bucket so the generated
        // alias is anchored on the dominant spelling.
        const dominant =
          current.payees.length > existing.payees.length ? current : existing;
        merged.set(root, {
          token: dominant.token,
          payees: [...existing.payees, ...current.payees],
        });
      }
    }

    return [...merged.values()];
  }

  private toGroupPreview(
    cluster: Cluster,
    minTokenLength: number,
  ): AutoMergeGroupPreview {
    // Canonical = most transactions, tie-break on shortest then alphabetical.
    const canonical = [...cluster.payees].sort((a, b) => {
      const ca = a.transactionCount ?? 0;
      const cb = b.transactionCount ?? 0;
      if (cb !== ca) return cb - ca;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    })[0];

    // Anchor the alias on the canonical's own leading token when available so
    // it reflects the kept spelling; fall back to the cluster token.
    const aliasToken =
      leadingSignificantToken(
        normalizePayeeName(canonical.name),
        minTokenLength,
      ) ?? cluster.token;

    const members: AutoMergeMember[] = cluster.payees
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

    return {
      groupKey: cluster.token,
      suggestedCanonicalPayeeId: canonical.id,
      suggestedName: canonical.name,
      suggestedAlias: `*${aliasToken}*`,
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

    const result: ApplyAutoMergeResult = {
      groupsMerged: 0,
      payeesMerged: 0,
      transactionsMigrated: 0,
      aliasesCreated: 0,
      skippedAliases: 0,
    };

    for (const group of groups) {
      const groupResult = await this.applyGroup(userId, group);
      result.groupsMerged += 1;
      result.payeesMerged += groupResult.payeesMerged;
      result.transactionsMigrated += groupResult.transactionsMigrated;
      result.aliasesCreated += groupResult.aliasCreated ? 1 : 0;
      result.skippedAliases += groupResult.aliasSkipped ? 1 : 0;
    }

    return result;
  }

  private async applyGroup(
    userId: string,
    group: ApplyAutoMergeGroup,
  ): Promise<{
    payeesMerged: number;
    transactionsMigrated: number;
    aliasCreated: boolean;
    aliasSkipped: boolean;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const canonical = await queryRunner.manager.findOne(Payee, {
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

      const sources = await queryRunner.manager.find(Payee, {
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

      // Optional rename of the canonical payee.
      const canonicalName = await this.maybeRenameCanonical(
        queryRunner,
        userId,
        canonical,
        group,
      );

      // Reassign each source's data to the canonical, then delete the source.
      let transactionsMigrated = 0;
      for (const source of sources) {
        const txResult = await queryRunner.manager.update(
          Transaction,
          { payeeId: source.id, userId },
          { payeeId: canonical.id, payeeName: canonicalName },
        );
        transactionsMigrated += txResult.affected || 0;

        await queryRunner.manager.update(
          ScheduledTransaction,
          { payeeId: source.id, userId },
          { payeeId: canonical.id, payeeName: canonicalName },
        );

        await queryRunner.manager.update(
          PayeeAlias,
          { payeeId: source.id, userId },
          { payeeId: canonical.id },
        );

        await queryRunner.manager.remove(Payee, source);
      }

      // Create the wildcard alias on the canonical.
      const aliasOutcome = await this.createGroupAlias(
        queryRunner,
        userId,
        canonical.id,
        group.alias,
      );

      await queryRunner.commitTransaction();

      return {
        payeesMerged: sources.length,
        transactionsMigrated,
        aliasCreated: aliasOutcome === "created",
        aliasSkipped: aliasOutcome === "skipped",
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async maybeRenameCanonical(
    queryRunner: QueryRunner,
    userId: string,
    canonical: Payee,
    group: ApplyAutoMergeGroup,
  ): Promise<string> {
    const desired = group.canonicalName?.trim();
    if (!desired || desired === canonical.name) {
      return canonical.name;
    }

    // Reject a rename that collides with a payee that is not part of this
    // group (the sources are deleted, so colliding with them is harmless).
    const excludedIds = new Set([canonical.id, ...group.sourcePayeeIds]);
    const conflict = await queryRunner.manager
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

    await queryRunner.manager.update(
      Payee,
      { id: canonical.id, userId },
      { name: desired },
    );
    // Keep the denormalized snapshot in sync on the canonical's own rows.
    await queryRunner.manager.update(
      Transaction,
      { payeeId: canonical.id, userId },
      { payeeName: desired },
    );
    await queryRunner.manager.update(
      ScheduledTransaction,
      { payeeId: canonical.id, userId },
      { payeeName: desired },
    );

    return desired;
  }

  private async createGroupAlias(
    queryRunner: QueryRunner,
    userId: string,
    canonicalId: string,
    rawAlias: string | undefined,
  ): Promise<"created" | "skipped" | "none"> {
    const alias = rawAlias?.trim();
    if (!alias) return "none";

    const allAliases = await queryRunner.manager.find(PayeeAlias, {
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
      await queryRunner.manager.remove(PayeeAlias, redundant);
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

    const newAlias = queryRunner.manager.create(PayeeAlias, {
      payeeId: canonicalId,
      userId,
      alias,
    });
    await queryRunner.manager.save(newAlias);
    return "created";
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import {
  DataSource,
  EntityManager,
  QueryDeepPartialEntity,
  Repository,
} from "typeorm";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { lockTransactionRuleList } from "../common/db/locks";
import { TransactionRule } from "./transaction-rule.entity";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";
import {
  RuleErrorEntry,
  checkReferences,
  withActionDefaults,
} from "./rule-references";
import { RuleDefinition, validateRuleDefinition } from "./rule-validation";
import { toRuleResponse, toRuleResponses } from "./transaction-rule-view";
import { MAX_TRANSACTION_RULES_PER_USER } from "./transaction-rules.limits";

/** A blank or absent date clears a side of the window. */
const blankToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

@Injectable()
export class TransactionRulesService {
  constructor(private readonly dataSource: DataSource) {}

  async list(userId: string): Promise<TransactionRuleResponseDto[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rules = await m.getRepository(TransactionRule).find({
        where: { userId },
        order: { position: "ASC" },
      });
      return toRuleResponses(m, userId, rules);
    });
  }

  async get(userId: string, id: string): Promise<TransactionRuleResponseDto> {
    return withScopedDb(this.dataSource, async (m) => {
      const rule = await this.findOwned(
        m.getRepository(TransactionRule),
        userId,
        id,
      );
      return (await toRuleResponses(m, userId, [rule]))[0];
    });
  }

  async create(
    userId: string,
    dto: CreateTransactionRuleDto,
  ): Promise<TransactionRuleResponseDto> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockRuleList(m, userId);
      const repo = m.getRepository(TransactionRule);
      if (
        (await repo.count({ where: { userId } })) >=
        MAX_TRANSACTION_RULES_PER_USER
      ) {
        throw new BadRequestException({
          message: tr(
            "errors.transactionRules.limitReached",
            `At most ${MAX_TRANSACTION_RULES_PER_USER} rules can be created`,
            { max: MAX_TRANSACTION_RULES_PER_USER },
          ),
          errorCode: "RULE_LIMIT_REACHED",
        });
      }
      const activeFrom = blankToNull(dto.activeFrom);
      const activeTo = blankToNull(dto.activeTo);
      this.assertActiveWindow(activeFrom, activeTo);
      const definition = await this.checkedDefinition(
        m,
        userId,
        dto.condition,
        dto.actions,
      );
      const saved = await repo.save(
        repo.create({
          userId,
          name: dto.name,
          enabled: dto.enabled ?? true,
          position: await this.nextPosition(repo, userId),
          triggers: dto.triggers,
          condition: definition.condition,
          actions: [...definition.actions],
          stopProcessing: dto.stopProcessing ?? false,
          activeFrom,
          activeTo,
        }),
      );
      // Just validated in this transaction, so it is not invalid.
      return toRuleResponse(saved, []);
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateTransactionRuleDto,
  ): Promise<TransactionRuleResponseDto> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockRuleList(m, userId);
      const repo = m.getRepository(TransactionRule);
      const rule = await this.findOwned(repo, userId, id);
      // The compare half of the CAS: refuse before anything is written.
      if (rule.revision !== dto.revision) throw this.revisionConflict();

      const changes = this.changedFields(rule, dto);
      // A form resends every field; a value that did not move is not an edit.
      if (Object.keys(changes).length === 0) {
        return (await toRuleResponses(m, userId, [rule]))[0];
      }
      // The window as it will be stored: a side the request leaves out keeps
      // its stored value, so moving one side cannot invert the other.
      this.assertActiveWindow(
        changes.activeFrom === undefined ? rule.activeFrom : changes.activeFrom,
        changes.activeTo === undefined ? rule.activeTo : changes.activeTo,
      );
      const definition = await this.checkedDefinition(
        m,
        userId,
        changes.condition ?? rule.condition,
        changes.actions ?? rule.actions,
        changes.condition !== undefined,
      );
      const patch: QueryDeepPartialEntity<TransactionRule> = {
        ...changes,
        ...(changes.condition && { condition: definition.condition }),
        ...(changes.actions && { actions: [...definition.actions] }),
        revision: () => "revision + 1",
      } as QueryDeepPartialEntity<TransactionRule>;
      // The swap half: the WHERE names the revision that was read, so a
      // writer that got past the list lock (another replica included, the
      // lock is a database row lock) still cannot overwrite a newer revision.
      const result = await repo.update(
        { id, userId, revision: dto.revision },
        patch,
      );
      if (!result.affected) throw this.revisionConflict();
      const updated = await this.findOwned(repo, userId, id);
      return toRuleResponse(updated, []);
    });
  }

  async setEnabled(
    userId: string,
    id: string,
    enabled: boolean,
  ): Promise<TransactionRuleResponseDto> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockRuleList(m, userId);
      const repo = m.getRepository(TransactionRule);
      const rule = await this.findOwned(repo, userId, id);
      if (rule.enabled === enabled) {
        return (await toRuleResponses(m, userId, [rule]))[0];
      }
      // Bumps the revision: an editor holding the old one must not save over
      // the toggle.
      await repo.update(
        { id, userId },
        { enabled, revision: () => "revision + 1" },
      );
      const updated = await this.findOwned(repo, userId, id);
      return (await toRuleResponses(m, userId, [updated]))[0];
    });
  }

  /**
   * `expectedRevision` is the caller's expectation (a confirmation card names
   * the revision it showed): a rule edited since is refused with 409 before the
   * delete, in the same transaction and under the same list lock.
   */
  async remove(
    userId: string,
    id: string,
    expectedRevision?: number,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      await this.lockRuleList(m, userId);
      if (expectedRevision !== undefined) {
        const rule = await this.findOwned(
          m.getRepository(TransactionRule),
          userId,
          id,
        );
        if (rule.revision !== expectedRevision) throw this.revisionConflict();
      }
      const result = await m
        .getRepository(TransactionRule)
        .delete({ id, userId });
      if (!result.affected) throw this.notFound(id);
      // Close the gap in the same transaction. Deferred unique constraint: the
      // rewrite is checked at commit, when positions are distinct again.
      await m.query(
        `UPDATE transaction_rules AS r
            SET position = ranked.new_position
           FROM (SELECT id, (ROW_NUMBER() OVER (ORDER BY position) - 1)::int AS new_position
                   FROM transaction_rules
                  WHERE user_id = $1) AS ranked
          WHERE r.id = ranked.id
            AND r.user_id = $1
            AND r.position <> ranked.new_position`,
        [userId],
      );
    });
  }

  async reorder(
    userId: string,
    ids: readonly string[],
  ): Promise<TransactionRuleResponseDto[]> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.lockRuleList(m, userId);
      const repo = m.getRepository(TransactionRule);
      const owned = await repo.find({
        where: { userId },
        select: { id: true },
      });
      // Exactly the user's rules, each once: a partial, stale or repeating
      // list would leave positions ambiguous.
      const ownedIds = new Set(owned.map((r) => r.id));
      const requested = new Set(ids);
      if (
        requested.size !== ids.length ||
        requested.size !== ownedIds.size ||
        !ids.every((id) => ownedIds.has(id))
      ) {
        throw new ConflictException({
          message: tr(
            "errors.transactionRules.reorderMismatch",
            "The list of rules has changed. Reload it and try again",
          ),
          errorCode: "RULE_LIST_CHANGED",
        });
      }
      await m.query(
        `UPDATE transaction_rules AS r
            SET position = (u.ord - 1)::int
           FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, ord)
          WHERE r.id = u.id
            AND r.user_id = $1
            AND r.position <> (u.ord - 1)::int`,
        [userId, [...ids]],
      );
      const rules = await repo.find({
        where: { userId },
        order: { position: "ASC" },
      });
      return toRuleResponses(m, userId, rules);
    });
  }

  /**
   * Serializes every write to one user's rule list (create's `max + 1`, the
   * 200-rule cap, delete's compaction, reorder): a transaction-scoped advisory
   * lock per user (`lockTransactionRuleList`,
   * docs/concurrency-and-idempotency.md mechanism 6), taken before the first
   * read and released at commit. It touches no row, so nothing else that
   * writes the user's rows waits on it. The deferred unique index on
   * (user_id, position) is the backstop: a writer that skipped the lock fails
   * at commit instead of storing two rules at one position.
   */
  private lockRuleList(m: EntityManager, userId: string): Promise<void> {
    return lockTransactionRuleList(m, userId);
  }

  private async nextPosition(
    repo: Repository<TransactionRule>,
    userId: string,
  ): Promise<number> {
    const row = await repo
      .createQueryBuilder("r")
      .select("MAX(r.position)", "max")
      .where("r.userId = :userId", { userId })
      .getRawOne<{ max: number | string | null }>();
    return row?.max === null || row?.max === undefined
      ? 0
      : Number(row.max) + 1;
  }

  /**
   * A rule the caller owns, read in the caller's transaction (404 otherwise).
   * `share` takes a row share lock, so an edit of the rule waits for a run
   * that is planning and writing with the revision it read.
   */
  async getOwnedRule(
    m: EntityManager,
    userId: string,
    id: string,
    options: { share?: boolean } = {},
  ): Promise<TransactionRule> {
    const rule = await m.getRepository(TransactionRule).findOne({
      where: { id, userId },
      ...(options.share ? { lock: { mode: "pessimistic_read" as const } } : {}),
    });
    if (!rule) throw this.notFound(id);
    return rule;
  }

  private async findOwned(
    repo: Repository<TransactionRule>,
    userId: string,
    id: string,
  ): Promise<TransactionRule> {
    const rule = await repo.findOne({ where: { id, userId } });
    if (!rule) throw this.notFound(id);
    return rule;
  }

  /**
   * The fields of `dto` whose value differs from the stored row. Actions get
   * the `onlyIfEmpty` default first, so a resent action that relied on it is
   * not a change.
   */
  private changedFields(
    rule: TransactionRule,
    dto: UpdateTransactionRuleDto,
  ): Partial<
    Pick<
      TransactionRule,
      | "name"
      | "enabled"
      | "triggers"
      | "condition"
      | "actions"
      | "stopProcessing"
      | "activeFrom"
      | "activeTo"
    >
  > {
    const next = {
      name: dto.name,
      enabled: dto.enabled,
      triggers: dto.triggers,
      condition: dto.condition as TransactionRule["condition"] | undefined,
      actions: withActionDefaults(dto.actions) as
        | TransactionRule["actions"]
        | undefined,
      stopProcessing: dto.stopProcessing,
      // A blank or null clears the side; an absent key leaves it alone.
      activeFrom:
        dto.activeFrom === undefined ? undefined : blankToNull(dto.activeFrom),
      activeTo:
        dto.activeTo === undefined ? undefined : blankToNull(dto.activeTo),
    };
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      if (
        value !== undefined &&
        !isDeepStrictEqual(value, rule[key as keyof TransactionRule])
      ) {
        changes[key] = value;
      }
    }
    return changes;
  }

  /**
   * Shape, bounds and ownership of a definition, in the caller's transaction.
   * Throws a 400 carrying the structured `errors` list; nothing has been
   * written by then.
   */
  async checkedDefinition(
    m: EntityManager,
    userId: string,
    condition: unknown,
    actions: unknown,
    authoring = true,
  ): Promise<RuleDefinition> {
    const candidate = { condition, actions: withActionDefaults(actions) };
    // `authoring` adds the glob-trap advice (regex-looking or bare-word
    // patterns); an update that leaves the condition alone passes false so a
    // stored rule that predates the advice can still have its name or actions
    // edited.
    const shapeErrors = validateRuleDefinition(candidate, { authoring });
    if (shapeErrors.length > 0) throw this.invalidDefinition(shapeErrors);
    const definition = candidate as unknown as RuleDefinition;
    const missing = await checkReferences(m, userId, definition);
    if (missing.length > 0) throw this.invalidDefinition(missing);
    return definition;
  }

  /**
   * An empty window (from after to) could never match a row; refused before
   * anything is written. `YYYY-MM-DD` strings compare in date order.
   */
  private assertActiveWindow(
    activeFrom: string | null,
    activeTo: string | null,
  ): void {
    if (activeFrom !== null && activeTo !== null && activeFrom > activeTo) {
      throw this.activeWindowInvalid();
    }
  }

  /** The refusal for a window whose first day is after its last. */
  activeWindowInvalid(): BadRequestException {
    return new BadRequestException({
      message: tr(
        "errors.transactionRules.activeWindowInvalid",
        "The first active date must not be after the last active date",
      ),
      errorCode: "ACTIVE_WINDOW_INVALID",
    });
  }

  private invalidDefinition(
    errors: readonly RuleErrorEntry[],
  ): BadRequestException {
    const onlyReferences = errors.every(
      (e) => e.code === "REFERENCE_NOT_FOUND",
    );
    return new BadRequestException({
      message: onlyReferences
        ? tr(
            "errors.transactionRules.referenceNotFound",
            "The rule names an account, payee, category or tag that does not exist",
          )
        : tr(
            "errors.transactionRules.invalidDefinition",
            "The rule definition is not valid",
          ),
      errorCode: onlyReferences ? "REFERENCE_NOT_FOUND" : "INVALID_RULE",
      errors: errors.map(({ path, code }) => ({ path, code })),
    });
  }

  private revisionConflict(): ConflictException {
    return new ConflictException({
      message: tr(
        "errors.transactionRules.revisionConflict",
        "This rule was changed elsewhere. Reload it and try again",
      ),
      errorCode: "REVISION_CONFLICT",
    });
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.transactionRules.notFound",
        `Transaction rule with ID ${id} not found`,
        { id },
      ),
    );
  }
}

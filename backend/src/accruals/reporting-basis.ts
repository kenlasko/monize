import { BadRequestException } from "@nestjs/common";
import { preferredCurrency } from "../common/default-currency.util";
import { AsyncLocalStorage } from "node:async_hooks";
import { type DataSource, type EntityManager } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withScopedDb } from "../common/db/scoped-db";
export type ReportingBasis = "cash" | "accrual";
export interface ReportingReadContext {
  userId: string;
  basis: ReportingBasis;
  convert: boolean;
  currency: string;
  resultCurrency?: string;
  accrualEnabled?: boolean;
  executionByScope?: Map<string, ReportingBasis>;
}
const reads = new AsyncLocalStorage<ReportingReadContext>();
export function currentReportingRead(userId: string) {
  const value = reads.getStore();
  return value?.userId === userId ? value : undefined;
}
export function reportingResultCurrency(userId: string, currency: string) {
  const context = currentReportingRead(userId);
  if (context) context.resultCurrency = currency;
}
export async function resolveReportingBasis(
  m: EntityManager,
  userId: string,
  requested?: ReportingBasis,
): Promise<ReportingBasis> {
  const context = currentReportingRead(userId);
  if (context?.accrualEnabled !== undefined)
    return context.accrualEnabled ? (requested ?? context.basis) : "cash";
  const pref = await m
    .getRepository(UserPreference)
    .findOne({ where: { userId } });
  return pref?.accrualEnabled === true
    ? (requested ?? pref.reportingBasis ?? "cash")
    : "cash";
}
export async function withReportingRead<T>(
  dataSource: DataSource,
  userId: string,
  fn: () => Promise<T>,
  requested?: ReportingBasis,
  convert = false,
): Promise<T> {
  if (
    requested !== undefined &&
    requested !== "cash" &&
    requested !== "accrual"
  )
    throw new BadRequestException({
      code: "REPORTING_BASIS_INVALID",
      allowed: ["cash", "accrual"],
    });
  const existing = currentReportingRead(userId);
  if (existing && (requested === undefined || requested === existing.basis))
    return fn();
  const pref = await withScopedDb(dataSource, (m) =>
    m.getRepository(UserPreference).findOne({ where: { userId } }),
  );
  return reads.run(
    {
      userId,
      basis:
        pref?.accrualEnabled === true
          ? (requested ?? pref.reportingBasis ?? "cash")
          : "cash",
      accrualEnabled: pref?.accrualEnabled === true,
      executionByScope: new Map(),
      convert,
      currency: preferredCurrency(pref),
    },
    async () => {
      if (reads.getStore()!.basis === "accrual")
        await withScopedDb(dataSource, (manager) =>
          resolveReportingExecution(manager, userId),
        );
      const result = await fn();
      if (result && typeof result === "object" && !Array.isArray(result))
        return {
          ...result,
          basis:
            (result as Record<string, unknown>).basis === "cash" ||
            (result as Record<string, unknown>).basis === "accrual"
              ? (result as Record<string, unknown>).basis
              : reads.getStore()!.basis,
        };
      return result;
    },
  );
}
/** Domain readers share defaults across REST, assistant/MCP and internal calls. Cash-only operations opt out explicitly. */
export function ReportingRead(
  basis?: ReportingBasis,
  convert = false,
  requestedArgument?: number,
): MethodDecorator {
  return (_target, _name, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (
      userId: string,
      ...args: unknown[]
    ) => Promise<unknown>;
    descriptor.value = function (
      this: { dataSource: DataSource },
      userId: string,
      ...args: unknown[]
    ) {
      return withReportingRead(
        this.dataSource,
        userId,
        () => original.apply(this, [userId, ...args]),
        basis ??
          (requestedArgument === undefined
            ? undefined
            : typeof args[requestedArgument] === "object" &&
                args[requestedArgument] !== null
              ? (args[requestedArgument] as { basis?: ReportingBasis }).basis
              : (args[requestedArgument] as ReportingBasis | undefined)),
        convert,
      );
    };
  };
}

/** Physical execution is independent of the selected view when no schedule can change it.
 * The memo belongs to one read context, never a user/global cache. */
export async function resolveReportingExecution(
  manager: EntityManager,
  userId: string,
  requested?: ReportingBasis,
  jointAccountIds: readonly string[] = [],
): Promise<ReportingBasis> {
  const selected = await resolveReportingBasis(manager, userId, requested);
  if (selected === "cash") return "cash";
  const context = currentReportingRead(userId);
  const key = JSON.stringify([...new Set(jointAccountIds)].sort());
  const cached = context?.executionByScope?.get(key);
  if (cached) return cached;
  const params: unknown[] = [userId];
  const joint = jointAccountIds.length
    ? ` OR EXISTS(SELECT 1 FROM public.accrual_schedules s JOIN public.transactions t ON t.id=s.source_transaction_id AND t.user_id=s.user_id WHERE t.account_id=ANY($2::uuid[]))`
    : "";
  if (jointAccountIds.length) params.push([...jointAccountIds]);
  const [row] = await manager.query(
    `SELECT EXISTS(SELECT 1 FROM public.accrual_schedules WHERE user_id=$1)${joint} AS present`,
    params,
  );
  const execution = row?.present === true ? "accrual" : "cash";
  context?.executionByScope?.set(key, execution);
  return execution;
}

/** Physical basis for readers already running inside a reporting context. */
export function reportingExecutionBasis(userId: string): ReportingBasis {
  return currentReportingRead(userId)?.executionByScope?.get("[]") ?? "cash";
}

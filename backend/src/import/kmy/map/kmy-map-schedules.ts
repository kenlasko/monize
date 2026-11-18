import { MappedBill, MappedBills } from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmySchedule, KmyTemplateSplit } from "../model/kmy-raw";
import { KMY_TYPE, isAssetOrLiability } from "./kmy-account-tree";
import { isIsoDate } from "./kmy-amounts";
import { KmyMapContext } from "./kmy-row-builder";
import { scheduleShape } from "./kmy-schedule-shape";
import {
  OCCURRENCE,
  cadenceFor,
  firstOccurrenceAfter,
  lastDayOf,
  normalizeOccurrence,
  stepOccurrence,
} from "./kmy-schedule-cadence";

/** Spec 5.10: which schedules are offered, their cadence and fields. */

class ScheduleMapper {
  readonly bills: MappedBill[] = [];
  readonly warnings: MnyWarning[] = [];
  skipped = 0;

  constructor(
    private readonly context: KmyMapContext,
    private readonly asOf: string,
  ) {}

  private warn(
    code: MnyWarning["code"],
    schedule: KmySchedule,
    detail?: string,
  ): void {
    this.warnings.push({
      code,
      subject: schedule.name.trim() || `schedule ${schedule.ordinal}`,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  private unusable(schedule: KmySchedule, detail: string): void {
    this.skipped += 1;
    this.warn("unusableBill", schedule, detail);
  }

  /** The next due date (spec 5.10.3), or null when the schedule has none. */
  private nextDue(
    schedule: KmySchedule,
    base: ReturnType<typeof normalizeOccurrence>,
  ): string | null {
    if (base === null || !schedule.template) {
      return null;
    }
    const post = isIsoDate(schedule.template.postDate)
      ? schedule.template.postDate
      : null;
    const start = isIsoDate(schedule.startDate) ? schedule.startDate : null;
    const last = isIsoDate(schedule.lastPayment) ? schedule.lastPayment : null;
    const candidate =
      post !== null && schedule.lastDayInMonth ? lastDayOf(post) : post;
    if (candidate !== null && (last === null || candidate > last)) {
      return candidate;
    }
    if (start === null) {
      return null;
    }
    if (candidate === null && last === null) {
      return start;
    }
    return last === null
      ? start
      : firstOccurrenceAfter(last, start, base, schedule.lastDayInMonth);
  }

  map(schedule: KmySchedule): void {
    const { context } = this;
    const base = normalizeOccurrence(schedule.occurrence, schedule.multiplier);
    const template = schedule.template;
    if (template === null || base === null) {
      this.unusable(
        schedule,
        template === null ? "no template" : `occurrence=${schedule.occurrence}`,
      );
      return;
    }
    const splits = template.splits;
    const typeOf = (split: KmyTemplateSplit): number | undefined =>
      context.tree.byId.get(split.account)?.type;
    if (splits.some((split) => typeOf(split) === KMY_TYPE.STOCK)) {
      this.skipped += 1;
      this.warn("investmentScheduleNotImported", schedule);
      return;
    }
    const assets = splits.filter((split) => {
      const type = typeOf(split);
      return (
        type !== undefined &&
        (isAssetOrLiability(type) || type === KMY_TYPE.UNKNOWN)
      );
    });
    if (assets.length === 0) {
      this.unusable(schedule, "no asset or liability split");
      return;
    }

    const due = this.nextDue(schedule, base);
    if (due === null) {
      this.unusable(schedule, "no usable date");
      return;
    }
    const endDate = isIsoDate(schedule.endDate) ? schedule.endDate : null;
    const lastPayment = isIsoDate(schedule.lastPayment)
      ? schedule.lastPayment
      : null;
    if (
      lastPayment !== null &&
      (base.base === OCCURRENCE.ONCE ||
        (endDate !== null && (lastPayment >= endDate || due > endDate)))
    ) {
      return; // finished (reference 11.3): not offered
    }

    const shape = scheduleShape(context, schedule, splits, assets);
    if (shape === null) {
      this.unusable(schedule, "no importable account or amount");
      return;
    }

    const cadence = cadenceFor(base, due, schedule.lastDayInMonth);
    if (cadence.approximate) {
      this.warn("billFrequencyApproximated", schedule);
    }
    if (schedule.weekendOption !== 0) {
      this.warn("scheduleWeekendRuleDropped", schedule);
    }
    if (schedule.autoEnter) {
      this.warn("scheduleAutoEnterNotImported", schedule);
    }
    if (shape.loan) {
      this.warn("loanScheduleSimplified", schedule);
    }
    const start = isIsoDate(schedule.startDate) ? schedule.startDate : due;
    const next = stepOccurrence(due, base, start, schedule.lastDayInMonth);
    if ((next ?? due) < this.asOf) {
      this.warn("scheduleOverdue", schedule, due);
    }

    const payeeId = splits.find((split) => split.payee)?.payee ?? null;
    const payeeHandle = payeeId
      ? (context.payeeHandleById.get(payeeId) ?? null)
      : null;
    const tagHandles = [
      ...new Set(
        splits
          .flatMap((split) => split.tags)
          .map((id) => context.tagHandleById.get(id))
          .filter((handle): handle is number => handle !== undefined),
      ),
    ];
    const memo = [shape.memo, template.memo].find((text) => text.trim() !== "");
    this.bills.push({
      handle: schedule.ordinal,
      seriesKey: schedule.ordinal,
      status: schedule.type,
      name:
        schedule.name.trim() ||
        context.raw.payees.find((payee) => payee.id === payeeId)?.name.trim() ||
        `Schedule ${schedule.ordinal}`,
      accountKey: shape.accountKey,
      payeeHandle,
      categoryHandle: shape.categoryHandle,
      amount: shape.amount,
      currencyCode: shape.currencyCode,
      frequency: cadence.frequency,
      customRecurrence: cadence.customRecurrence,
      approximate: cadence.approximate,
      nextDueDate: due,
      endDate,
      description: memo ?? null,
      isTransfer: shape.transferAccountKey !== null,
      transferAccountKey: shape.transferAccountKey,
      investment: null,
      splits: shape.splits,
      tagHandles,
    });
  }
}

export function mapKmySchedules(
  context: KmyMapContext,
  asOf: string,
): MappedBills {
  const mapper = new ScheduleMapper(context, asOf);
  for (const schedule of context.raw.schedules) {
    mapper.map(schedule);
  }
  return {
    bills: mapper.bills,
    seriesInFile: context.raw.schedules.length,
    skipped: mapper.skipped,
    supported: true,
    warnings: mapper.warnings,
  };
}

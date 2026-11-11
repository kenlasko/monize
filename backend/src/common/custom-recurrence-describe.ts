import {
  CustomRecurrence,
  LAST_DAY_OF_MONTH,
  normalizeCustomRecurrence,
} from "./custom-recurrence";

/**
 * A Custom rule in plain English for a language model's prompt or tool output
 * ("every week on Mon, Wed, Fri"), never for a person: the client writes the
 * localized summary (`describeCustomRecurrence`, docs/specs/custom-recurrence.md
 * section 6). The bare word "CUSTOM" tells a model nothing about how often a
 * bill falls due.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** A yearly rule may hold 366 dates; a prompt names the first few and a count. */
const MAX_DATES_NAMED = 12;

function every(interval: number, unit: string): string {
  return interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
}

export function describeCustomRecurrenceForModel(
  raw: CustomRecurrence | null | undefined,
): string {
  const result = normalizeCustomRecurrence(raw);
  if (!result.ok) return "custom schedule (rule unreadable)";
  const rule = result.rule;
  if (rule.unit === "WEEK") {
    const days = (rule.weekdays ?? []).map((d) => WEEKDAYS[d - 1]);
    return `${every(rule.interval, "week")} on ${days.join(", ")}`;
  }
  if (rule.unit === "MONTH") {
    const days = (rule.monthDays ?? []).map((d) =>
      d === LAST_DAY_OF_MONTH ? "last day" : String(d),
    );
    return `${every(rule.interval, "month")} on day ${days.join(", ")}`;
  }
  const dates = rule.dates ?? [];
  const named = dates.slice(0, MAX_DATES_NAMED).map((md) => {
    const [mm, dd] = md.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${dd}`;
  });
  const rest =
    dates.length > MAX_DATES_NAMED
      ? ` and ${dates.length - MAX_DATES_NAMED} more dates`
      : "";
  return `${every(rule.interval, "year")} on ${named.join(", ")}${rest}`;
}

/** A schedule's frequency for a model: the stored word, or the Custom rule spelled out. */
export function describeFrequencyForModel(
  frequency: string,
  rule: CustomRecurrence | null | undefined,
): string {
  return frequency === "CUSTOM"
    ? `custom: ${describeCustomRecurrenceForModel(rule)}`
    : frequency;
}

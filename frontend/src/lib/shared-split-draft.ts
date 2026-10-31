import type {
  SharedEntry,
  SharedEntryInput,
  SharedGroupDetail,
} from "@/types/shared-expense";

type Share = SharedEntryInput["shares"][number];
/** Inputs are machine decimal strings from the shared localized numeric controls. */
function units(value: string, places: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("invalid split");
  const [integer, fraction = ""] = value.split(".");
  if (fraction.slice(places).replace(/0/g, ""))
    throw new Error("invalid split");
  return (
    BigInt(integer) * BigInt(10) ** BigInt(places) +
    BigInt(fraction.slice(0, places).padEnd(places, "0") || "0")
  );
}
function decimal(value: bigint, places: number): string {
  if (value < BigInt(0)) return `-${decimal(-value, places)}`;
  const text = value.toString().padStart(places + 1, "0");
  return places ? `${text.slice(0, -places)}.${text.slice(-places)}` : text;
}

/** Feedback for an unfinished editor, independent of the server's accepted allocations. */
export function splitDraftStatus(
  amount: string,
  mode: SharedEntryInput["splitMode"],
  rows: readonly Share[],
  places: number,
): { valid: boolean; remaining: string | null } {
  if (!rows.length) return { valid: false, remaining: null };
  try {
    if (mode === "EQUAL") return { valid: true, remaining: null };
    if (mode === "WEIGHT")
      return {
        valid:
          rows.every((row) => row.value !== "") &&
          rows.reduce(
            (sum, row) => sum + units(row.value || "0", 4),
            BigInt(0),
          ) > BigInt(0),
        remaining: null,
      };
    const precision = mode === "PERCENT" ? 2 : places;
    const target = mode === "PERCENT" ? BigInt(10000) : units(amount, places);
    const rest =
      target -
      rows.reduce(
        (sum, row) => sum + units(row.value || "0", precision),
        BigInt(0),
      );
    return { valid: rest === BigInt(0), remaining: decimal(rest, precision) };
  } catch {
    return { valid: false, remaining: null };
  }
}
export function assignRemainder(
  amount: string,
  rows: readonly Share[],
  participantId: string,
  places: number,
): Share[] {
  const rest =
    units(amount, places) -
    rows
      .filter((r) => r.participantId !== participantId)
      .reduce((sum, r) => sum + units(r.value || "0", places), BigInt(0));
  if (rest < BigInt(0)) throw new Error("invalid split");
  return rows.map((row) =>
    row.participantId === participantId
      ? { ...row, value: decimal(rest, places) }
      : row,
  );
}
/** This produces explicit amounts for review, never the journal's implicit equal split. */
export function extrasThenEqual(
  amount: string,
  rows: readonly Share[],
  places: number,
): Share[] {
  if (!rows.length) throw new Error("invalid split");
  const rest =
    units(amount, places) -
    rows.reduce((sum, r) => sum + units(r.value || "0", places), BigInt(0));
  if (rest < BigInt(0)) throw new Error("invalid split");
  const ordered = [...rows].sort((a, b) =>
    a.participantId.localeCompare(b.participantId, "en"),
  );
  const base = rest / BigInt(rows.length);
  const leftover = Number(rest % BigInt(rows.length));
  return rows.map((row) => ({
    ...row,
    value: decimal(
      units(row.value || "0", places) +
        base +
        (ordered.findIndex((r) => r.participantId === row.participantId) <
        leftover
          ? BigInt(1)
          : BigInt(0)),
      places,
    ),
  }));
}

/** Fill only blank final shares; an entered zero is a fixed amount too. */
export function splitRemainderEqually(
  amount: string,
  rows: readonly Share[],
  places: number,
): Share[] {
  const recipients = rows.filter(
    (row) => row.value === undefined || row.value === "",
  );
  if (!recipients.length) throw new Error("invalid split");
  const rest =
    units(amount, places) -
    rows.reduce((sum, row) => sum + units(row.value || "0", places), BigInt(0));
  if (rest < BigInt(0)) throw new Error("invalid split");
  const allocated = new Map(
    extrasThenEqual(decimal(rest, places), recipients, places).map((row) => [
      row.participantId,
      row,
    ]),
  );
  return rows.map((row) => allocated.get(row.participantId) ?? row);
}

export function initialSharedEntry(
  group: SharedGroupDetail,
  today: string,
  entry?: SharedEntry,
): SharedEntryInput {
  const template = usableSharedTemplate(group);
  return entry
    ? {
        operationId: crypto.randomUUID(),
        expectedRevision: entry.revision,
        type: entry.type,
        title: entry.title,
        amount: entry.originalAmount,
        currencyCode: entry.currencyCode,
        date: entry.date,
        note: entry.note ?? "",
        categoryLabel: entry.categoryLabel ?? "",
        splitMode: entry.splitMode,
        shares: entry.allocations
          .filter((a) => a.kind === "SHARE")
          .map((a) => ({
            participantId: a.participantId,
            ...(entry.splitMode === "EQUAL"
              ? {}
              : { value: a.instructionValue ?? a.originalAmount }),
          })),
        contributions: entry.allocations
          .filter((a) => a.kind === "CONTRIBUTION")
          .map((a) => ({
            participantId: a.participantId,
            value: a.originalAmount,
          })),
        // Omit the rate on an unchanged entry: the server preserves its original provenance.
        ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
        ...(entry.fromParticipantId
          ? { fromParticipantId: entry.fromParticipantId }
          : {}),
        ...(entry.toParticipantId
          ? { toParticipantId: entry.toParticipantId }
          : {}),
        expectedGroupRevision: group.financialRevision,
      }
    : {
        operationId: crypto.randomUUID(),
        expectedRevision: 0,
        type: "EXPENSE",
        title: "",
        amount: "",
        currencyCode: group.currencyCode,
        date: today,
        splitMode: template?.mode ?? "EQUAL",
        shares:
          template?.shares.map((row) => ({ ...row })) ??
          group.participants
            .filter((p) => p.isActive)
            .map((p) => ({ participantId: p.id })),
        contributions: group.myParticipantId
          ? [{ participantId: group.myParticipantId, value: "" }]
          : [],
      };
}

/** A deactivated participant invalidates the future-only template; history keeps its shares. */
export function usableSharedTemplate(group: SharedGroupDetail) {
  const template = group.splitTemplate;
  return template?.shares.length &&
    template.shares.every((s) =>
      group.participants.some((p) => p.id === s.participantId && p.isActive),
    )
    ? template
    : null;
}

import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useReportData } from "@/hooks/useReportData";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { splitDraftStatus } from "@/lib/shared-split-draft";
import type { SharedEntryInput } from "@/types/shared-expense";

/** Only a server preview for the current draft may enable Save. */
export function useSharedEntryPreview(
  groupId: string,
  input: SharedEntryInput,
  places: number | undefined,
  entryId?: string,
  paused = false,
) {
  const inputKey = JSON.stringify(input);
  const requestKey = JSON.stringify([groupId, entryId, inputKey]);
  const settledKey = useDebouncedValue(inputKey, 400);
  const hasFields =
    places !== undefined &&
    !!input.title.trim() &&
    Number(input.amount) > 0 &&
    !!input.date;
  const splitValid =
    places !== undefined &&
    (input.type === "REPAYMENT"
      ? !!input.fromParticipantId &&
        !!input.toParticipantId &&
        input.fromParticipantId !== input.toParticipantId
      : splitDraftStatus(input.amount, input.splitMode, input.shares, places)
          .valid);
  const paymentsValid =
    input.type === "REPAYMENT" ||
    (places !== undefined &&
      splitDraftStatus(input.amount, "EXACT", input.contributions, places)
        .valid);
  const ready = hasFields && splitValid && paymentsValid;
  const settled = inputKey === settledKey;
  const result = useReportData(
    async () => {
      if (!ready || !settled || paused) return null;
      try {
        return {
          entry: await sharedExpensesApi.preview(groupId, input, entryId),
          error: null,
        };
      } catch (error) {
        // A failure belongs to its draft just as a successful preview does.
        return { entry: null, error };
      }
    },
    [groupId, entryId, settledKey, ready, paused],
    { requestKey },
  );
  const current = ready && settled && !paused && result.dataKey === requestKey;
  return {
    preview: current && !result.isLoading ? (result.data?.entry ?? null) : null,
    error: current && !result.isLoading ? (result.data?.error ?? null) : null,
    pending: ready && !paused && (!settled || result.isLoading),
    validation:
      !hasFields || paused
        ? null
        : !splitValid
          ? input.type === "REPAYMENT"
            ? ("validation" as const)
            : ("amountChanged" as const)
          : !paymentsValid
            ? ("contributionsMismatch" as const)
            : null,
    retry: result.reload,
  };
}

import { SharedEntryDto } from "./dto/shared-entry.dto";
import { SharedJournalEntry } from "./shared-journal";
import { fixedUnits } from "./shared-money";

/** Accepted pennies survive metadata edits and detached restores with new UUIDs. */
export function unchangedAllocationInstructions(
  dto: SharedEntryDto,
  previous: SharedJournalEntry,
): boolean {
  if (dto.splitMode !== previous.splitMode) return false;
  const same = (kind: "SHARE" | "CONTRIBUTION") => {
    const inputs = kind === "SHARE" ? dto.shares : dto.contributions;
    const accepted = previous.allocations.filter((a) => a.kind === kind);
    if (
      inputs.length !== accepted.length ||
      new Set(inputs.map((a) => a.participantId)).size !== inputs.length
    )
      return false;
    const places = kind === "SHARE" && dto.splitMode === "PERCENT" ? 2 : 4;
    return inputs.every((input) => {
      const old = accepted.find((a) => a.participantId === input.participantId);
      if (!old) return false;
      if (kind === "SHARE" && dto.splitMode === "EQUAL") return true;
      return (
        fixedUnits(input.value!, places) ===
        fixedUnits(old.instructionValue ?? old.originalAmount, places)
      );
    });
  };
  return same("SHARE") && same("CONTRIBUTION");
}

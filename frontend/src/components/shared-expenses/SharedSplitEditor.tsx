"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { FormActions } from "@/components/ui/FormActions";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { NumericInput } from "@/components/ui/NumericInput";
import type {
  SharedEntryInput,
  SharedParticipant,
  SharedSplitMode,
} from "@/types/shared-expense";
import { extrasThenEqual, splitDraftStatus } from "@/lib/shared-split-draft";
import {
  editSplitDraft,
  initialSplitDraft,
  resolveSplitDraft,
  splitRatios,
} from "@/lib/shared-split-editor";
import { clamp } from "@/lib/clamp";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useSharedEntryPreview } from "./useSharedEntryPreview";
import { SharedError, SharedMoneyInput } from "./SharedPrimitives";

export function SharedSplitEditor({
  groupId,
  entryId,
  input,
  participants,
  places,
  onApply,
  onClose,
  template = false,
  saveError,
  isSaving = false,
}: {
  groupId: string;
  entryId?: string;
  template?: boolean;
  saveError?: unknown;
  isSaving?: boolean;
  input: SharedEntryInput;
  participants: SharedParticipant[];
  places: number;
  onApply: (split: Pick<SharedEntryInput, "shares" | "splitMode">) => void;
  onClose: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatCurrency, formatPercent } = useNumberFormat();
  const idPrefix = useId();
  const [draft, setDraft] = useState(() => initialSplitDraft(input));
  const [toolsError, setToolsError] = useState(false);
  const [focusedAmount, setFocusedAmount] = useState<string | null>(null);
  const resolved = resolveSplitDraft(draft, input.amount, places);
  const ratios = splitRatios(resolved);
  const payer = input.contributions[0]?.participantId ?? draft.selected[0];
  const preview = useSharedEntryPreview(
    groupId,
    {
      ...input,
      title: input.title.trim() || t("splitMode"),
      splitMode: resolved.splitMode,
      shares: resolved.shares,
      // This read-only preview needs valid payers even before that field is finished.
      // Its SHARE rows alone are displayed; the parent previews the real payers.
      contributions: splitDraftStatus(
        input.amount,
        "EXACT",
        input.contributions,
        places,
      ).valid
        ? input.contributions
        : payer
          ? [{ participantId: payer, value: input.amount }]
          : [],
    },
    places,
    entryId,
    template || !resolved.status.valid,
  );
  const amounts = new Map(
    preview.preview?.allocations
      .filter((row) => row.kind === "SHARE")
      .map((row) => [row.participantId, row.originalAmount]),
  );
  const change = (
    mode: Exclude<SharedSplitMode, "EQUAL">,
    id: string,
    value: string,
  ) => {
    setToolsError(false);
    setDraft(editSplitDraft(draft, input.amount, places, mode, id, value));
  };
  const remaining = resolved.status.remaining;
  const status = !draft.selected.length
    ? t("selectPeople")
    : resolved.status.valid
      ? t("splitComplete")
      : remaining !== null
        ? t(Number(remaining) < 0 ? "splitOver" : "splitRemaining", {
            amount:
              draft.mode === "PERCENT"
                ? formatPercent(Math.abs(Number(remaining)), 2)
                : formatCurrency(
                    Math.abs(Number(remaining)),
                    input.currencyCode,
                  ),
          })
        : t("splitInvalid");
  return (
    <Modal
      pushHistory
      isOpen
      fullScreenOnPhone
      title={t("splitMode")}
      padding="none"
      className="p-6"
      maxWidth="2xl"
      onClose={onClose}
      onBeforeClose={() => (isSaving ? false : undefined)}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (resolved.status.valid && !isSaving)
            onApply({ splitMode: resolved.splitMode, shares: resolved.shares });
        }}
      >
        <SharedError error={saveError} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <p role="status" className="text-sm font-medium">
              {status}
            </p>
            <InfoTooltip text={t("unifiedSplitHelp")} usePortal />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              setDraft({ ...draft, mode: "EQUAL", values: {} });
              setToolsError(false);
            }}
          >
            {t("resetEqual")}
          </Button>
        </div>
        <fieldset disabled={isSaving} className="space-y-4">
          {participants
            .filter(
              (person) => person.isActive || draft.selected.includes(person.id),
            )
            .map((person) => {
              const selected = draft.selected.includes(person.id);
              const ratio = ratios[person.id];
              const percent =
                draft.mode === "PERCENT" &&
                draft.values[person.id] !== undefined &&
                draft.values[person.id] !== ""
                  ? Number(draft.values[person.id])
                  : ratio?.percent;
              const sliderPercent = clamp(percent ?? 0, 0, 100);
              const pinned =
                (draft.mode === "EXACT" || draft.mode === "PERCENT") &&
                !!draft.values[person.id]?.length;
              const amountPending =
                preview.pending && !pinned && focusedAmount !== person.id;
              return (
                <div
                  key={person.id}
                  className="space-y-3 border-b border-gray-100 dark:border-gray-700 pb-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-3 min-h-11 min-w-0 break-words">
                      <ToggleSwitch
                        label={person.name}
                        checked={selected}
                        onChange={(checked) => {
                          setDraft({
                            ...draft,
                            selected: checked
                              ? [...draft.selected, person.id]
                              : draft.selected.filter((id) => id !== person.id),
                          });
                        }}
                      />
                      {person.name}
                    </label>
                    {selected && pinned && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          change(
                            draft.mode as "EXACT" | "PERCENT",
                            person.id,
                            "",
                          )
                        }
                      >
                        {t("releaseShare", { name: person.name })}
                      </Button>
                    )}
                  </div>
                  {selected && (
                    <div
                      className={`grid min-w-0 items-start gap-3 ${template ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}
                    >
                      {!template && (
                        <SharedMoneyInput
                          key={amountPending ? "pending" : "ready"}
                          label={t("share", { name: person.name })}
                          value={
                            draft.mode === "EXACT" && pinned
                              ? draft.values[person.id]
                              : (amounts.get(person.id) ?? "")
                          }
                          onChange={(value) =>
                            change("EXACT", person.id, value)
                          }
                          currency={input.currencyCode}
                          places={places}
                          // Mount the ready field with its automatic amount already
                          // present; never replace a focused or explicitly edited field.
                          disabled={amountPending}
                          onFocus={() => setFocusedAmount(person.id)}
                          onBlur={() => setFocusedAmount(null)}
                        />
                      )}
                      <div className="min-w-0">
                        <NumericInput
                          id={`${idPrefix}-${person.id}-percent`}
                          label={t("percentFor", { name: person.name })}
                          value={percent}
                          decimalPlaces={2}
                          onChange={(value) =>
                            change(
                              "PERCENT",
                              person.id,
                              value === undefined ? "" : String(value),
                            )
                          }
                        />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={0.01}
                          value={sliderPercent}
                          aria-label={t("percentSliderFor", {
                            name: person.name,
                          })}
                          aria-valuetext={
                            percent === undefined
                              ? t("unknown")
                              : formatPercent(sliderPercent, 2)
                          }
                          onChange={(event) =>
                            change("PERCENT", person.id, event.target.value)
                          }
                          className="w-full h-6 mt-2 accent-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500"
                        />
                      </div>
                      <NumericInput
                        id={`${idPrefix}-${person.id}-weight`}
                        label={t("weightFor", { name: person.name })}
                        value={
                          ratio?.weight === undefined || ratio.weight === ""
                            ? undefined
                            : Number(ratio.weight)
                        }
                        decimalPlaces={4}
                        onChange={(value) =>
                          change(
                            "WEIGHT",
                            person.id,
                            value === undefined ? "" : String(value),
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
        </fieldset>
        {!template && preview.pending && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("checkingSplit")}
          </p>
        )}
        {!template &&
          !preview.pending &&
          !preview.preview &&
          !preview.error &&
          resolved.status.valid && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("splitAmountNeeded")}
            </p>
          )}
        <SharedError error={preview.error} retry={preview.retry} />
        {!template && draft.mode === "EXACT" && (
          <details>
            <summary className="cursor-pointer min-h-11 py-2 text-sm font-medium">
              {t("splitTools")}
            </summary>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => {
                  try {
                    const rows = extrasThenEqual(
                      input.amount,
                      draft.selected.map((participantId) => ({
                        participantId,
                        value: draft.values[participantId] ?? "",
                      })),
                      places,
                    );
                    setDraft(
                      initialSplitDraft({ splitMode: "EXACT", shares: rows }),
                    );
                    setToolsError(false);
                  } catch {
                    setToolsError(true);
                  }
                }}
              >
                {t("extras")}
              </Button>
              <InfoTooltip text={t("extrasHelp")} usePortal />
            </div>
          </details>
        )}
        {toolsError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {t("splitInvalid")}
          </p>
        )}
        <FormActions
          onCancel={onClose}
          submitLabel={t("apply")}
          isSubmitting={isSaving}
          submitDisabled={!resolved.status.valid}
        />
      </form>
    </Modal>
  );
}

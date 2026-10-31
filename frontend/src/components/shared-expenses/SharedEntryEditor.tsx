"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { FormActions } from "@/components/ui/FormActions";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { DateInput } from "@/components/ui/DateInput";
import { NumericInput } from "@/components/ui/NumericInput";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Card } from "@/components/ui/Card";
import { useFinancialToday } from "@/hooks/useFinancialToday";
import { type SharedDocument } from "@/lib/shared-documents";
import { exchangeRatesApi } from "@/lib/exchange-rates";
import { useReportData } from "@/hooks/useReportData";
import { AttachmentsSection } from "@/components/transactions/AttachmentsSection";
import { useSharedEntrySave } from "./useSharedEntrySave";
import {
  initialSharedEntry,
  usableSharedTemplate,
} from "@/lib/shared-split-draft";
import type {
  SharedEntry,
  SharedEntryInput,
  SharedEntryType,
  SharedGroupDetail,
  SharedSuggestion,
} from "@/types/shared-expense";
import {
  SharedError,
  SharedMoneyInput,
  SharedNotice,
} from "./SharedPrimitives";
import { SharedNavigationGuard } from "./SharedNavigationGuard";
import { SharedSplitEditor } from "./SharedSplitEditor";
import { useSharedEntryPreview } from "./useSharedEntryPreview";
import { SharedEntryPreview } from "./SharedEntryPreview";
const SharedDocuments = dynamic(
  () => import("./SharedDocuments").then((m) => m.SharedDocuments),
  { ssr: false },
);

export function SharedEntryEditor({
  group,
  entry,
  kind = "EXPENSE",
  suggestion,
  refundSource,
  sourceDocument,
  initialValues,
  onClose,
  onSaved,
}: {
  group: SharedGroupDetail;
  entry?: SharedEntry;
  kind?: SharedEntryType;
  suggestion?: SharedSuggestion;
  refundSource?: SharedEntry;
  sourceDocument?: SharedDocument;
  onClose: () => void;
  onSaved: (entry: SharedEntry) => void;
  initialValues?: Partial<SharedEntryInput>;
}) {
  const t = useTranslations("sharedExpenses");
  const common = useTranslations("common");
  const today = useFinancialToday();
  const [initial] = useState<SharedEntryInput>(() => {
    const base = initialSharedEntry(group, today, entry);
    if (entry) return base;
    if (kind === "REPAYMENT")
      return {
        ...base,
        type: kind,
        title: t("REPAYMENT"),
        amount: suggestion?.amount ?? "",
        shares: [],
        contributions: [],
        fromParticipantId:
          suggestion?.fromParticipantId ?? group.myParticipantId ?? "",
        toParticipantId: suggestion?.toParticipantId ?? "",
        expectedGroupRevision: group.financialRevision,
      };
    if (refundSource)
      return {
        ...base,
        type: "REFUND",
        title: refundSource.title,
        amount: "",
        currencyCode: refundSource.currencyCode,
        sourceEntryId: refundSource.id,
        splitMode: "WEIGHT",
        shares: refundSource.allocations
          .filter((a) => a.kind === "SHARE" && Number(a.originalAmount) > 0)
          .map((a) => ({
            participantId: a.participantId,
            value: a.originalAmount,
          })),
      };
    return {
      ...base,
      type: kind,
      ...initialValues,
      ...(sourceDocument
        ? { title: sourceDocument.filename.replace(/\.[^.]+$/, "") }
        : {}),
    };
  });
  const [input, setInput] = useState(initial);
  const [places, setPlaces] = useState(
    initial.currencyCode === group.currencyCode
      ? group.decimalPlaces
      : undefined,
  );
  const [split, setSplit] = useState(false);
  const [currencyChanged, setCurrencyChanged] = useState(false);
  const [discard, setDiscard] = useState(false);
  const saving = useSharedEntrySave({
    groupId: group.id,
    entryId: entry?.id,
    sourceDocument,
    onSaved,
    onClose,
  });
  const { saved, busy, error } = saving;
  const pendingFiles = saving.files.length > 0;
  const currencies = useReportData(() => exchangeRatesApi.getCurrencies(), []);
  const resolvedPlaces =
    places ??
    currencies.data?.find((c) => c.code === input.currencyCode)?.decimalPlaces;
  const [multiple, setMultiple] = useState(input.contributions.length > 1);
  const inputKey = JSON.stringify(input);
  const preview = useSharedEntryPreview(
    group.id,
    input,
    resolvedPlaces,
    entry?.id,
    !!saved,
  );
  const shownPreview = preview.preview;
  const dirty = JSON.stringify(initial) !== inputKey;
  const participants = group.participants.filter(
    (p) =>
      p.isActive ||
      input.shares.some((s) => s.participantId === p.id) ||
      input.contributions.some((s) => s.participantId === p.id),
  );
  const options = [
    { value: "", label: t("choose") },
    ...participants.map((p) => ({ value: p.id, label: p.name })),
  ];
  const change = (patch: Partial<SharedEntryInput>) => {
    setInput({ ...input, ...patch });
  };
  const close = () => {
    if (busy) return;
    if ((dirty && !saved) || pendingFiles) setDiscard(true);
    else onClose();
  };
  const save = () => saving.save(input, shownPreview);
  const label =
    input.type === "REPAYMENT"
      ? t("addRepayment")
      : input.type === "REFUND"
        ? t("refund")
        : entry
          ? t("edit")
          : t(input.type === "INCOME" ? "addIncome" : "addExpense");
  return (
    <>
      <SharedNavigationGuard
        when={busy || (dirty && !saved) || pendingFiles}
        message={common("unsavedChanges.message")}
      />
      <Modal
        pushHistory
        onBeforeClose={() => {
          if (busy) return false;
          if ((dirty && !saved) || pendingFiles) {
            setDiscard(true);
            return false;
          }
        }}
        isOpen
        fullScreenOnPhone
        title={saved ? t("saved") : label}
        onClose={close}
        padding="none"
        className="p-6"
        maxWidth="2xl"
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            if (!busy && (saved || shownPreview)) void save();
          }}
        >
          <SharedError error={error} />
          {input.type === "REPAYMENT" && (
            <InfoTooltip text={t("repaymentHelp")} usePortal />
          )}
          {saved && <SharedNotice>{t("savedFilesPending")}</SharedNotice>}
          {currencyChanged && !preview.validation && (
            <SharedNotice>{t("amountChanged")}</SharedNotice>
          )}
          <fieldset disabled={busy || !!saved} className="space-y-4">
            <Input
              label={t("entryTitle")}
              value={input.title}
              maxLength={120}
              autoFocus
              onChange={(e) => change({ title: e.target.value })}
            />
            <SharedMoneyInput
              label={t("amount")}
              value={input.amount}
              currency={input.currencyCode}
              baseCurrency={group.currencyCode}
              places={resolvedPlaces ?? 4}
              disabled={resolvedPlaces === undefined}
              onChange={(amount) =>
                change({
                  amount,
                  ...(!multiple && input.contributions.length === 1
                    ? {
                        contributions: [
                          { ...input.contributions[0], value: amount },
                        ],
                      }
                    : {}),
                })
              }
              onCurrencyChange={
                input.type === "REFUND"
                  ? undefined
                  : (currencyCode) => {
                      if (currencyCode === input.currencyCode) return;
                      setCurrencyChanged(true);
                      setPlaces(
                        currencyCode === group.currencyCode
                          ? group.decimalPlaces
                          : undefined,
                      );
                      currencies.reload();
                      change({
                        currencyCode,
                        fxRate: undefined,
                        amount: "",
                        contributions: input.contributions.map((part) => ({
                          ...part,
                          value: "",
                        })),
                        ...(input.splitMode === "EXACT"
                          ? {
                              shares: input.shares.map((part) => ({
                                ...part,
                                value: "",
                              })),
                            }
                          : {}),
                      });
                    }
              }
            />
            <SharedError error={currencies.error} retry={currencies.reload} />
            {input.type === "REPAYMENT" ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Select
                    label={t("from")}
                    value={input.fromParticipantId}
                    options={options}
                    onChange={(e) =>
                      change({ fromParticipantId: e.target.value })
                    }
                  />
                  <Select
                    label={t("to")}
                    value={input.toParticipantId}
                    options={options}
                    onChange={(e) =>
                      change({ toParticipantId: e.target.value })
                    }
                  />
                </div>
                <label className="flex gap-3 items-start text-sm">
                  <ToggleSwitch
                    label={t("overpayment")}
                    checked={input.acknowledgeOverpayment ?? false}
                    onChange={(checked) =>
                      change({ acknowledgeOverpayment: checked })
                    }
                  />
                  {t("overpayment")}
                </label>
              </>
            ) : (
              <>
                <div className="space-y-1">
                  {!multiple ? (
                    <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
                      <Select
                        label={t(
                          input.type === "EXPENSE" ? "paidBy" : "receivedBy",
                        )}
                        value={input.contributions[0]?.participantId ?? ""}
                        options={options}
                        onChange={(e) =>
                          change({
                            contributions: e.target.value
                              ? [
                                  {
                                    participantId: e.target.value,
                                    value: input.amount,
                                  },
                                ]
                              : [],
                          })
                        }
                      />
                      <DateInput
                        label={t("date")}
                        value={input.date}
                        onDateChange={(date) => change({ date })}
                      />
                    </div>
                  ) : (
                    <fieldset className="space-y-3">
                      <legend className="text-sm font-medium">
                        {t(input.type === "EXPENSE" ? "paidBy" : "receivedBy")}
                      </legend>
                      {participants.map((person) => (
                        <SharedMoneyInput
                          key={person.id}
                          label={t("contribution", { name: person.name })}
                          value={
                            input.contributions.find(
                              (c) => c.participantId === person.id,
                            )?.value ?? ""
                          }
                          currency={input.currencyCode}
                          places={resolvedPlaces ?? 4}
                          disabled={resolvedPlaces === undefined}
                          onChange={(value) =>
                            change({
                              contributions: [
                                ...input.contributions.filter(
                                  (c) => c.participantId !== person.id,
                                ),
                                ...(value && Number(value) > 0
                                  ? [{ participantId: person.id, value }]
                                  : []),
                              ],
                            })
                          }
                        />
                      ))}
                    </fieldset>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMultiple(!multiple);
                      if (multiple)
                        change({
                          contributions: [
                            {
                              participantId:
                                input.contributions[0]?.participantId ??
                                group.myParticipantId ??
                                "",
                              value: input.amount,
                            },
                          ],
                        });
                    }}
                  >
                    {t(
                      multiple
                        ? "singleContributor"
                        : input.type === "EXPENSE"
                          ? "multiplePayers"
                          : "multipleReceivers",
                    )}
                  </Button>
                </div>
                <Card padding="sm">
                  <div className="flex flex-wrap justify-between items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{t("splitBetween")}</p>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {input.splitMode === "EQUAL"
                          ? t("equalSummary", { count: input.shares.length })
                          : t(input.splitMode)}
                      </p>
                      <p className="text-sm break-words mt-1">
                        {participants
                          .filter((p) =>
                            input.shares.some((s) => s.participantId === p.id),
                          )
                          .map((p) => p.name)
                          .join(", ")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={resolvedPlaces === undefined}
                      onClick={() => setSplit(true)}
                    >
                      {t("split")}
                    </Button>
                  </div>
                </Card>
                {input.type === "REFUND" && (
                  <SharedNotice>{t("refundHelp")}</SharedNotice>
                )}
              </>
            )}
            {!entry && input.type === "EXPENSE" && group.splitTemplate && (
              <SharedNotice>
                {t(
                  usableSharedTemplate(group)
                    ? "templateApplied"
                    : "templateUnavailable",
                )}
              </SharedNotice>
            )}
            {(input.type === "REPAYMENT" || multiple) && (
              <DateInput
                label={t("date")}
                value={input.date}
                onDateChange={(date) => change({ date })}
              />
            )}
            <details
              className="space-y-3"
              open={!!shownPreview?.draftReason || undefined}
            >
              <summary className="cursor-pointer min-h-10 text-sm font-medium">
                {t("advanced")}
              </summary>
              <Input
                label={t("note")}
                value={input.note ?? ""}
                maxLength={750}
                onChange={(e) => change({ note: e.target.value })}
              />
              <Input
                label={t("categoryLabel")}
                value={input.categoryLabel ?? ""}
                maxLength={60}
                onChange={(e) => change({ categoryLabel: e.target.value })}
              />
              {input.currencyCode !== group.currencyCode &&
                input.type !== "REFUND" && (
                  <>
                    <NumericInput
                      label={t("fxRate")}
                      decimalPlaces={10}
                      value={input.fxRate ? Number(input.fxRate) : undefined}
                      onChange={(rate) =>
                        change({
                          fxRate: rate === undefined ? undefined : String(rate),
                        })
                      }
                    />
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {t("fxHelp", {
                        from: input.currencyCode,
                        to: group.currencyCode,
                      })}
                    </p>
                  </>
                )}
            </details>
            {shownPreview && (
              <SharedEntryPreview entry={shownPreview} group={group} compact />
            )}
            {preview.pending && (
              <p
                role="status"
                className="text-sm text-gray-500 dark:text-gray-400"
              >
                {t("checkingSplit")}
              </p>
            )}
            {preview.validation && (
              <SharedNotice>{t(preview.validation)}</SharedNotice>
            )}
            <SharedError error={preview.error} retry={preview.retry} />
          </fieldset>
          <fieldset disabled={busy} className="pt-4">
            <AttachmentsSection
              stagedFiles={saving.files}
              onStagedFilesChange={saving.queue}
              pendingHint={t("entryUploadHint")}
            />
          </fieldset>
          {entry && (
            <SharedDocuments
              group={group}
              entryId={entry.id}
              allowUpload={false}
            />
          )}
          <FormActions
            onCancel={close}
            isSubmitting={busy}
            submitDisabled={!saved && !shownPreview}
            submitLabel={
              saved ? t("retry") : entry ? t("saveChanges") : t("save")
            }
          />
        </form>
      </Modal>
      {split && (
        <SharedSplitEditor
          groupId={group.id}
          entryId={entry?.id}
          input={input}
          participants={participants}
          places={resolvedPlaces ?? 4}
          onClose={() => setSplit(false)}
          onApply={(value) => {
            change(value);
            setSplit(false);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={discard}
        title={t("discardTitle")}
        message={
          pendingFiles
            ? t("pendingFilesLeave")
            : common("unsavedChanges.message")
        }
        confirmLabel={t("discard")}
        cancelLabel={t("keepEditing")}
        onCancel={() => setDiscard(false)}
        onConfirm={onClose}
      />
    </>
  );
}

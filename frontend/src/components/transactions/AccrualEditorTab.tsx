"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  accrualsApi,
  type AccrualInput,
  type AccrualPreview,
  type AccrualScheduleSummary,
} from "@/lib/accruals";
import { clearAllCache } from "@/lib/apiCache";
import type { UpdateTransactionData } from "@/types/transaction";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { NumericInput } from "@/components/ui/NumericInput";
import { AccrualPreviewTable } from "./AccrualPreviewTable";

export type EditorSetting = AccrualInput & { remove?: boolean };
export interface EditorPreview {
  fingerprint: string;
  previews: (AccrualPreview & {
    sourceSplitId: string | null;
    remove?: boolean;
  })[];
}
export function useAccrualEditorDraft(sourceId?: string) {
  const t = useTranslations("transactions.accrual");
  const generation = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    id: string;
    attempt: number;
    schedules: AccrualScheduleSummary[];
    error?: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    settings: EditorSetting[];
  } | null>(null);
  const [review, setReview] = useState<{
    id: string;
    patch: UpdateTransactionData;
    settings: EditorSetting[];
    value: EditorPreview;
  } | null>(null);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    accrualsApi
      .sourceSchedules(sourceId)
      .then(async (schedules) => {
        if (cancelled) return;
        setLoaded({ id: sourceId, attempt, schedules });
        const settings = schedules.map<EditorSetting>((schedule) => ({
          sourceTransactionId: sourceId,
          sourceSplitId: schedule.sourceSplitId,
          preset: schedule.preset,
          dateRule: schedule.dateRule,
          ...(schedule.preset === "CUSTOM"
            ? {
                startMonth: schedule.startMonth,
                monthCount: schedule.monthCount,
              }
            : {}),
          family: schedule.family,
        }));
        const origin = generation.current;
        const value = await accrualsApi.editorPreview(sourceId, {
          patch: {},
          settings,
        });
        if (!cancelled && origin === generation.current)
          setReview({ id: sourceId, patch: {}, settings, value });
      })
      .catch(() => {
        if (!cancelled)
          setLoaded({ id: sourceId, attempt, schedules: [], error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, attempt]);
  const current =
    loaded && loaded.id === sourceId && loaded.attempt === attempt
      ? loaded
      : null;
  const settings =
    draft && draft.id === sourceId
      ? draft.settings
      : (current?.schedules ?? []).map<EditorSetting>((schedule) => ({
          sourceTransactionId: sourceId!,
          sourceSplitId: schedule.sourceSplitId,
          preset: schedule.preset,
          dateRule: schedule.dateRule,
          ...(schedule.preset === "CUSTOM"
            ? {
                startMonth: schedule.startMonth,
                monthCount: schedule.monthCount,
              }
            : {}),
          family: schedule.family,
        }));
  const settingsRef = useRef<{ id: string; settings: EditorSetting[] } | null>(
    null,
  );
  const invalidate = () => {
    generation.current += 1;
    setReview(null);
    setChanged(true);
  };
  const update = (next: EditorSetting[]) => {
    if (!sourceId) return;
    settingsRef.current = { id: sourceId, settings: next };
    setDraft({ id: sourceId, settings: next });
    invalidate();
  };
  const snapshotInput = (patch: UpdateTransactionData) => {
    const savedDraft = settingsRef.current;
    const currentSettings =
      savedDraft && savedDraft.id === sourceId ? savedDraft.settings : settings;
    const next = currentSettings.map((setting) =>
      patch.splits !== undefined &&
      (setting.sourceSplitId
        ? !patch.splits.some(
            (line) => "id" in line && line.id === setting.sourceSplitId,
          )
        : patch.splits.length > 0)
        ? { ...setting, remove: true }
        : setting,
    );
    return JSON.parse(JSON.stringify({ patch, settings: next }));
  };
  const preview = async (patch: UpdateTransactionData) => {
    if (!sourceId || !current || current.error) throw new Error(t("failed"));
    const frozen = snapshotInput(patch);
    const origin = generation.current;
    const value = await accrualsApi.editorPreview(sourceId, frozen);
    if (origin !== generation.current) return value;
    setReview({ id: sourceId, ...frozen, value });
    return value;
  };
  const save = async (patch: UpdateTransactionData) => {
    if (!sourceId || !current || current.error) throw new Error(t("failed"));
    const frozen = snapshotInput(patch);
    const origin = generation.current;
    const reviewed =
      review &&
      review.id === sourceId &&
      JSON.stringify(review.patch) === JSON.stringify(frozen.patch) &&
      JSON.stringify(review.settings) === JSON.stringify(frozen.settings);
    if (!reviewed) {
      await preview(patch);
      return false;
    }
    if (origin !== generation.current) return false;
    try {
      await accrualsApi.editorSave(sourceId, {
        ...frozen,
        fingerprint: review!.value.fingerprint,
      });
    } catch (error) {
      setReview(null);
      throw error;
    }
    clearAllCache();
    return true;
  };
  return {
    reviewed:
      !!review &&
      review.id === sourceId &&
      Object.keys(review.patch).length > 0,
    ready: !!current && !current.error,
    failed: !!current?.error,
    retry: () => setAttempt((value) => value + 1),
    hasSchedules: !!current?.schedules.length,
    settings,
    update,
    preview,
    save,
    invalidate,
    changed,
    value: review && review.id === sourceId ? review.value : null,
  };
}
export function AccrualEditorTab({
  sourceId,
  paymentMonth,
  components,
  editor,
  onPreview,
  busy,
  highlightDate,
}: {
  sourceId: string;
  paymentMonth: string;
  components: {
    id: string | null;
    label: string;
    family: "expense" | "income" | null;
  }[];
  editor: ReturnType<typeof useAccrualEditorDraft>;
  onPreview: () => void;
  busy: boolean;
  highlightDate?: string;
}) {
  const t = useTranslations("transactions.accrual");
  const [chosen, setChosen] = useState("");
  const component =
    components.find((value) => (value.id ?? "") === chosen) ?? components[0];
  const setting = editor.settings.find(
    (value) => (value.sourceSplitId ?? null) === component?.id,
  );
  const value = setting ?? {
    sourceTransactionId: sourceId,
    sourceSplitId: component?.id,
    preset: "NTM" as const,
    dateRule: "MONTH_END" as const,
    family: component?.family ?? "expense",
  };
  const change = (patch: Partial<EditorSetting>) => {
    editor.update([
      ...editor.settings.filter(
        (value) => (value.sourceSplitId ?? null) !== component?.id,
      ),
      { ...value, ...patch },
    ]);
  };
  return (
    <section aria-label={t("title")} className="space-y-4">
      <p>{t("help")}</p>
      <p>{t("reviewHelp")}</p>
      {editor.failed ? (
        <div role="alert">
          <p>{t("failed")}</p>
          <Button type="button" onClick={editor.retry}>
            {t("retry")}
          </Button>
        </div>
      ) : !editor.ready ? (
        <p role="status">{t("title")}</p>
      ) : (
        <>
          {components.length > 1 && (
            <Select
              label={t("component")}
              value={component?.id ?? ""}
              options={components.map((value) => ({
                value: value.id ?? "",
                label: value.label,
              }))}
              onChange={(event) => setChosen(event.target.value)}
            />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <fieldset disabled={busy} className="space-y-4">
              <Select
                label={t("preset")}
                value={value.preset}
                options={(["LTM", "NTM", "CUSTOM"] as const).map((preset) => ({
                  value: preset,
                  label: t(preset),
                }))}
                onChange={(event) =>
                  change({
                    preset: event.target.value as EditorSetting["preset"],
                    startMonth:
                      event.target.value === "CUSTOM"
                        ? paymentMonth
                        : undefined,
                    monthCount:
                      event.target.value === "CUSTOM" ? 12 : undefined,
                    remove: false,
                  })
                }
              />
              <Select
                label={t("dateRule")}
                value={value.dateRule ?? "MONTH_END"}
                options={(["MONTH_END", "FIRST_BUSINESS_DAY"] as const).map((dateRule) => ({
                  value: dateRule,
                  label: t(dateRule),
                }))}
                onChange={(event) =>
                  change({
                    dateRule: event.target.value as EditorSetting["dateRule"],
                  })
                }
              />
              {value.preset === "CUSTOM" && (
                <>
                  <Input
                    label={t("start")}
                    type="month"
                    value={value.startMonth ?? paymentMonth}
                    onChange={(event) =>
                      change({ startMonth: event.target.value })
                    }
                  />
                  <NumericInput
                    label={t("months")}
                    value={value.monthCount ?? 12}
                    decimalPlaces={0}
                    min={1}
                    max={600}
                    onChange={(monthCount) => change({ monthCount })}
                  />
                </>
              )}
              {!component?.family && (
                <Select
                  label={t("family")}
                  value={value.family ?? "expense"}
                  options={(["expense", "income"] as const).map((family) => ({
                    value: family,
                    label: t(family),
                  }))}
                  onChange={(event) =>
                    change({
                      family: event.target.value as "expense" | "income",
                    })
                  }
                />
              )}
              <Button
                type="button"
                disabled={busy || !component}
                onClick={() => {
                  if (!setting) change({});
                  onPreview();
                }}
              >
                {t("preview")}
              </Button>
              {setting && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => change({ remove: !setting.remove })}
                >
                  {setting.remove ? t("existing") : t("remove")}
                </Button>
              )}
              {setting?.remove && <p>{t("removeHelp")}</p>}
            </fieldset>
            <div className="space-y-4">
              {editor.value?.previews
                .filter((row) => row.sourceSplitId === component?.id)
                .map((row) =>
                  row.remove ? (
                    <p key="remove">{t("removeImpact")}</p>
                  ) : (
                    <AccrualPreviewTable
                      key={row.sourceSplitId ?? "whole"}
                      preview={row}
                      highlightDate={editor.changed ? undefined : highlightDate}
                    />
                  ),
                )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

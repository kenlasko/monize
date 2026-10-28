"use client";

import { useEffect, useRef, useState } from "react";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useTranslations } from "next-intl";
import { AxiosError } from "axios";
import toast from "react-hot-toast";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { NumericInput } from "@/components/ui/NumericInput";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { getErrorMessage } from "@/lib/errors";
import {
  accrualsApi,
  type AccrualDetail,
  type AccrualFamily,
  type AccrualInput,
  type AccrualPreset,
  type AccrualPreview,
  type AccrualScheduleSummary,
} from "@/lib/accruals";
import { AccrualPlanTable, AccrualPreviewTable } from "./AccrualPreviewTable";

export interface AccrualComponent {
  id: string | null;
  label: string;
  family: AccrualFamily | null;
}
interface Props {
  embedded?: boolean;
  transactionId: string;
  paymentMonth: string;
  component: AccrualComponent;
  schedule?: AccrualScheduleSummary;
  disabled?: boolean;
  onSaved: () => void;
  onBusyChange: (busy: boolean) => void;
  onStale?: () => void;
}
export function AccrualForm({
  embedded = false,
  transactionId,
  paymentMonth,
  component,
  schedule,
  disabled,
  onSaved,
  onBusyChange,
  onStale,
}: Props) {
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const t = useTranslations("transactions.accrual");
  const tc = useTranslations("common");
  const [preset, setPreset] = useState<AccrualPreset>(
    schedule?.preset ?? "NTM",
  );
  const [startMonth, setStartMonth] = useState(
    schedule?.startMonth ?? paymentMonth,
  );
  const [monthCount, setMonthCount] = useState<number | undefined>(
    schedule?.monthCount ?? 12,
  );
  const [family, setFamily] = useState<AccrualFamily>(
    schedule?.family ?? component.family ?? "expense",
  );
  const [preview, setPreview] = useState<{
    input: AccrualInput;
    value: AccrualPreview;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusyChange(value);
  };
  const [removing, setRemoving] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const detailKey = `${schedule?.id}:${detailVersion}`;
  const [detail, setDetail] = useState<{
    key: string;
    value?: AccrualDetail;
    error?: string;
  } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!schedule) return;
    let cancelled = false;
    accrualsApi
      .detail(schedule.id)
      .then((value) => {
        if (!cancelled) setDetail({ key: detailKey, value });
      })
      .catch((reason) => {
        if (!cancelled)
          setDetail({
            key: detailKey,
            error: getErrorMessage(reason, t("failed")),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [schedule, detailKey, t]);
  const currentDetail = detail?.key === detailKey ? detail : null;
  const changed = () => {
    setPreview(null);
    setRemoving(false);
    setError(null);
  };
  const fail = (reason: unknown) => {
    if (!alive.current) return;
    setPreview(null);
    setRemoving(false);
    if (reason instanceof AxiosError && reason.response?.status === 409) {
      setDetailVersion((value) => value + 1);
      setError(t("changed"));
      onStale?.();
    } else setError(getErrorMessage(reason, t("failed")));
  };
  async function review() {
    const input: AccrualInput = {
      sourceTransactionId: transactionId,
      sourceSplitId: component.id,
      preset,
      family: component.family ?? family,
      ...(preset === "CUSTOM" ? { startMonth, monthCount } : {}),
    };
    setBusy(true);
    setError(null);
    setRemoving(false);
    setPreview(null);
    try {
      const value = await accrualsApi.preview(input);
      if (alive.current) setPreview({ input, value });
    } catch (reason) {
      fail(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await accrualsApi.save(preview.input, preview.value);
      toast.success(t("saved"));
      onSaved();
    } catch (reason) {
      fail(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove() {
    if (!currentDetail?.value) return;
    setBusy(true);
    setError(null);
    try {
      await accrualsApi.remove(currentDetail.value);
      toast.success(t("removed"));
      onSaved();
    } catch (reason) {
      fail(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const invalidCustom =
    preset === "CUSTOM" &&
    (!/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth) ||
      !Number.isInteger(monthCount) ||
      monthCount! < 1 ||
      monthCount! > 600);
  return (
    <div className="space-y-4">
      {schedule && <Badge variant="blue">{t("existing")}</Badge>}
      {schedule && !currentDetail && <p role="status">{tc("loading")}</p>}
      {currentDetail?.error && (
        <div role="alert">
          <p>{currentDetail.error}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDetailVersion((value) => value + 1)}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      <div
        className={
          embedded
            ? "grid grid-cols-1 lg:grid-cols-2 gap-6 items-start"
            : "space-y-4"
        }
      >
        <fieldset disabled={busy} className="space-y-4">
          <Select
            label={t("preset")}
            value={preset}
            options={(["LTM", "NTM", "CUSTOM"] as const).map((value) => ({
              value,
              label: t(value),
            }))}
            onChange={(event) => {
              changed();
              setPreset(event.target.value as AccrualPreset);
            }}
          />
          {preset === "CUSTOM" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                type="month"
                label={t("start")}
                value={startMonth}
                min="0001-01"
                max="9999-12"
                onChange={(event) => {
                  changed();
                  setStartMonth(event.target.value);
                }}
              />
              <NumericInput
                label={t("months")}
                value={monthCount}
                decimalPlaces={0}
                min={1}
                max={600}
                onChange={(value) => {
                  changed();
                  setMonthCount(value);
                }}
              />
            </div>
          )}
          {!component.family && (
            <Select
              label={t("family")}
              value={family}
              options={(["expense", "income"] as const).map((value) => ({
                value,
                label: t(value),
              }))}
              onChange={(event) => {
                changed();
                setFamily(event.target.value as AccrualFamily);
              }}
            />
          )}
          <Button
            type="button"
            onClick={() => void review()}
            disabled={invalidCustom || disabled}
            isLoading={busy}
          >
            {t("preview")}
          </Button>
        </fieldset>
        <div className="space-y-4 min-w-0">
          {error && (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {preview && (
            <>
              <AccrualPreviewTable preview={preview.value} />
              <Button
                type="button"
                onClick={() => void save()}
                disabled={busy || disabled}
                isLoading={busy}
              >
                {tc("save")}
              </Button>
            </>
          )}
          {schedule && currentDetail?.value && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-3">
              <details open={embedded || undefined}>
                <summary>{t("existing")}</summary>
                <p>
                  {t("source", {
                    date: formatDate(currentDetail.value.source.paymentDate),
                    amount: formatCurrency(
                      Number(currentDetail.value.source.amount),
                      currentDetail.value.source.currencyCode,
                      4,
                    ),
                  })}
                </p>
                <AccrualPlanTable
                  plan={currentDetail.value.plan}
                  currency={currentDetail.value.source.currencyCode}
                />
              </details>
              {!removing ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(true);
                    setPreview(null);
                    setError(null);
                  }}
                >
                  {t("remove")}
                </Button>
              ) : (
                <>
                  <p>{t("removeHelp")}</p>
                  <AccrualPlanTable
                    plan={currentDetail.value.plan}
                    currency={currentDetail.value.source.currencyCode}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void remove()}
                      isLoading={busy}
                    >
                      {t("remove")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setRemoving(false)}
                    >
                      {tc("cancel")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

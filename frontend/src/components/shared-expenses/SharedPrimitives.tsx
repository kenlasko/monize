"use client";

import { useEffect, useId } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Select } from "@/components/ui/Select";
import { CurrencyPickerButton } from "@/components/transactions/CurrencyPickerButton";
import { CurrencyInput } from "@/components/ui/CurrencyInput";
import {
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  toolbarSegmentClass,
} from "@/components/ui/segmented-control";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useReportData } from "@/hooks/useReportData";
import { exchangeRatesApi } from "@/lib/exchange-rates";
import { getErrorMessage } from "@/lib/errors";
import { withCurrencyCode } from "@/lib/format";

export function SharedError({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  if (!error) return null;
  return (
    <div role="alert">
      <EmptyState
        className="py-4"
        icon={<ExclamationTriangleIcon />}
        title={getErrorMessage(error, t("loadFailed"))}
        action={
          retry ? (
            <Button size="sm" variant="outline" type="button" onClick={retry}>
              {t("retry")}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function SharedAmount({
  amount,
  currency,
  relativeTo,
  className = "",
}: {
  amount: string | null;
  currency: string;
  relativeTo?: string;
  className?: string;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatCurrency, defaultCurrency } = useNumberFormat();
  return (
    <span className={`tabular-nums whitespace-nowrap ${className}`}>
      {amount === null
        ? t("unknown")
        : withCurrencyCode(
            formatCurrency(Number(amount), currency),
            currency,
            relativeTo && relativeTo !== currency
              ? relativeTo
              : defaultCurrency,
          )}
    </span>
  );
}

export function SharedMoneyInput({
  label,
  value,
  onChange,
  currency,
  places = 2,
  baseCurrency = currency,
  onCurrencyChange,
  disabled = false,
  onFocus,
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  currency: string;
  places?: number;
  baseCurrency?: string;
  onCurrencyChange?: (code: string) => void;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const inputId = useId();
  const number = value === "" ? undefined : Number(value);
  const change = (next: number | undefined) =>
    onChange(next === undefined ? "" : String(next));
  return (
    <div className="flex items-stretch space-x-2">
      <CurrencyPickerButton
        value={currency === baseCurrency ? "" : currency}
        accountCurrencyCode={baseCurrency}
        baseCurrencyLabel={baseCurrency}
        onChange={(code) => onCurrencyChange?.(code || baseCurrency)}
        disabled={!onCurrencyChange}
      />
      <div className="min-w-0 flex-1">
        <CurrencyInput
          id={inputId}
          label={label}
          value={number}
          onChange={change}
          decimalPlaces={places}
          allowNegative={false}
          disabled={disabled}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      </div>
    </div>
  );
}

export function SharedCurrencySelect({
  label,
  help,
  value,
  onChange,
  onResolved,
  disabled,
}: {
  label?: string;
  help?: string;
  value: string;
  onChange: (code: string, places: number) => void;
  onResolved?: (places: number) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("sharedExpenses");
  const id = useId();
  const data = useReportData(() => exchangeRatesApi.getCurrencies(), []);
  const resolvedPlaces = data.data?.find(
    (currency) => currency.code === value,
  )?.decimalPlaces;
  useEffect(() => {
    if (resolvedPlaces !== undefined) onResolved?.(resolvedPlaces);
  }, [resolvedPlaces, onResolved]);
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label
          htmlFor={id}
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {label ?? t("currency")}
        </label>
        {help && <InfoTooltip text={help} usePortal />}
      </div>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        options={[
          ...(!data.data?.some((c) => c.code === value)
            ? [{ value, label: value }]
            : []),
          ...(data.data ?? []).map((c) => ({
            value: c.code,
            label: `${c.code} · ${c.name}`,
          })),
        ]}
        onChange={(event) => {
          const currency = data.data?.find(
            (c) => c.code === event.target.value,
          );
          if (currency) onChange(currency.code, currency.decimalPlaces);
        }}
      />
      <SharedError error={data.error} retry={data.reload} />
    </div>
  );
}

export function SharedTabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`${SEGMENTED_TOOLBAR_GROUP_CLASS} flex-wrap gap-1 max-w-full`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          className={`${toolbarSegmentClass(value === option.value)} min-h-10 focus-visible:ring-2 focus-visible:ring-blue-500`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SharedNotice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100">
      {children}
    </p>
  );
}

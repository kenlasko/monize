"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Combobox } from "@/components/ui/Combobox";
import { Select } from "@/components/ui/Select";
import { NumericInput } from "@/components/ui/NumericInput";
import { useReportData } from "@/hooks/useReportData";
import { transactionsApi } from "@/lib/transactions";
import type { Account } from "@/types/account";
import type {
  SharedBankPaymentInput,
  SharedOriginalBank,
} from "@/types/shared-expense";
import {
  SharedAmount,
  SharedError,
  SharedMoneyInput,
  SharedTabs,
} from "./SharedPrimitives";
import { SharedTransactionPicker } from "./SharedTransactionPicker";

/** One own payment. The parent allocates the contribution between these sources. */
export function SharedBankPaymentEditor({
  input,
  onChange,
  accounts,
  categories,
  groupCurrency,
  originalCurrency,
  multiple,
  originalBanks = [],
}: {
  input: SharedBankPaymentInput;
  onChange: (patch: Partial<SharedBankPaymentInput>) => void;
  accounts: Account[];
  categories: { value: string; label: string }[];
  groupCurrency: string;
  originalCurrency: string;
  multiple: boolean;
  originalBanks?: SharedOriginalBank[];
}) {
  const t = useTranslations("sharedExpenses");
  const inputId = useId();
  const [mode, setMode] = useState<"existingBank" | "newBank">(
    input.bankAccountId ? "newBank" : "existingBank",
  );
  const [matchingAccount, setMatchingAccount] = useState("");
  const [chosen, setChosen] = useState<{
    label: string;
    amount: string;
    currency: string;
  } | null>(null);
  const bank = useReportData(
    () =>
      input.bankTransactionId
        ? transactionsApi.getById(input.bankTransactionId)
        : Promise.resolve(null),
    [input.bankTransactionId],
  );
  const selected = bank.data?.id === input.bankTransactionId ? bank.data : null;
  const source =
    originalBanks.find((row) => row.id === input.bankTransactionId) ?? selected;
  const sourceSplits =
    mode === "existingBank" && source?.isSplit ? source.splits : undefined;
  const label =
    selected?.payee?.name ||
    selected?.payeeName ||
    selected?.description ||
    chosen?.label;
  const amount = selected
    ? String(Math.abs(Number(selected.amount)))
    : (chosen?.amount ?? "");
  const currency =
    mode === "existingBank"
      ? (selected?.currencyCode ?? chosen?.currency ?? groupCurrency)
      : (accounts.find((a) => a.id === input.bankAccountId)?.currencyCode ??
        groupCurrency);
  const clearSource = {
    bankAccountId: undefined,
    bankTransactionId: undefined,
    bankAmount: undefined,
    sharedBankAmount: undefined,
    bankRate: undefined,
    sourceSplits: undefined,
  };
  return (
    <div className="space-y-4">
      <SharedError error={bank.error} retry={bank.reload} />
      {multiple && (
        <SharedMoneyInput
          label={t("contributionPart")}
          value={input.contributionAmount ?? ""}
          currency={originalCurrency}
          places={4}
          onChange={(contributionAmount) => onChange({ contributionAmount })}
        />
      )}
      <SharedTabs
        label={t("bankTransaction")}
        value={mode}
        options={(["existingBank", "newBank"] as const).map((value) => ({
          value,
          label: t(value),
        }))}
        onChange={(value) => {
          setMode(value);
          setChosen(null);
          onChange(clearSource);
        }}
      />
      <Select
        id={`${inputId}-account`}
        label={t("bankAccount")}
        value={
          mode === "newBank"
            ? (input.bankAccountId ?? "")
            : (selected?.accountId ?? matchingAccount)
        }
        options={[
          { value: "", label: t("choose") },
          ...accounts.map((a) => ({
            value: a.id,
            label: `${a.name} · ${a.currencyCode}`,
          })),
        ]}
        onChange={(e) => {
          setMatchingAccount(e.target.value);
          setChosen(null);
          onChange({
            ...clearSource,
            bankAccountId:
              mode === "newBank" ? e.target.value || undefined : undefined,
          });
        }}
      />
      {mode === "existingBank" ? (
        input.bankTransactionId ? (
          <Card padding="sm">
            <p className="break-words">{label || t("existingBank")}</p>
            {amount && (
              <SharedAmount
                amount={amount}
                currency={currency}
                relativeTo={groupCurrency}
              />
            )}
            <Button
              variant="ghost"
              onClick={() => {
                onChange(clearSource);
                setChosen(null);
              }}
            >
              {t("edit")}
            </Button>
          </Card>
        ) : (
          matchingAccount && (
            <SharedTransactionPicker
              accountId={matchingAccount}
              onChoose={(row) => {
                onChange({ bankTransactionId: row.id });
                setChosen({
                  label:
                    row.payee?.name ||
                    row.payeeName ||
                    row.description ||
                    t("bankTransaction"),
                  amount: String(Math.abs(Number(row.amount))),
                  currency: row.currencyCode,
                });
              }}
            />
          )
        )
      ) : (
        <SharedMoneyInput
          label={t("bankAmount")}
          value={input.bankAmount ?? ""}
          places={4}
          currency={currency}
          onChange={(bankAmount) => onChange({ bankAmount })}
        />
      )}
      {sourceSplits ? (
        <fieldset className="space-y-3">
          <legend className="font-medium">{t("sourceSplitPortions")}</legend>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("sourceSplitHelp")}
          </p>
          {sourceSplits.map((split) => (
            <div key={split.id} className="space-y-1">
              <SharedMoneyInput
                label={t("sourceSplitPart", {
                  name:
                    split.memo ||
                    categories.find(
                      (category) => category.value === split.categoryId,
                    )?.label ||
                    t("category"),
                })}
                value={
                  input.sourceSplits?.find((part) => part.splitId === split.id)
                    ?.amount ?? ""
                }
                currency={currency}
                places={4}
                onChange={(amount) =>
                  onChange({
                    sourceSplits: [
                      ...(input.sourceSplits ?? []).filter(
                        (part) => part.splitId !== split.id,
                      ),
                      ...(amount && Number(amount) !== 0
                        ? [{ splitId: split.id, amount }]
                        : []),
                    ],
                    sharedBankAmount: undefined,
                  })
                }
              />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("amount")}:{" "}
                <SharedAmount
                  amount={String(Math.abs(Number(split.amount)))}
                  currency={currency}
                  relativeTo={groupCurrency}
                />
              </p>
            </div>
          ))}
        </fieldset>
      ) : null}
      <details className="space-y-3">
        <summary className="min-h-10 cursor-pointer text-sm font-medium">
          {t("advanced")}
        </summary>
        {!sourceSplits && (
          <SharedMoneyInput
            label={t("sharedBankAmount")}
            value={
              input.sharedBankAmount ??
              (mode === "existingBank" ? amount : (input.bankAmount ?? ""))
            }
            places={4}
            currency={currency}
            onChange={(sharedBankAmount) =>
              onChange({ sharedBankAmount: sharedBankAmount || undefined })
            }
          />
        )}
        {!sourceSplits && (
          <Combobox
            aria-label={t("privateCategory")}
            label={t("privateCategory")}
            placeholder={t("choose")}
            options={categories}
            value={input.privateCategoryId ?? ""}
            onChange={(privateCategoryId) =>
              onChange({ privateCategoryId: privateCategoryId || undefined })
            }
            usePortal
          />
        )}
        <Combobox
          aria-label={t("fxCategory")}
          label={t("fxCategory")}
          placeholder={t("choose")}
          options={categories}
          value={input.fxCategoryId ?? ""}
          onChange={(fxCategoryId) =>
            onChange({ fxCategoryId: fxCategoryId || undefined })
          }
          usePortal
        />
        {currency !== groupCurrency && (
          <NumericInput
            id={`${inputId}-rate`}
            label={t("fxRate")}
            decimalPlaces={10}
            value={input.bankRate ? Number(input.bankRate) : undefined}
            onChange={(v) =>
              onChange({ bankRate: v === undefined ? undefined : String(v) })
            }
          />
        )}
      </details>
    </div>
  );
}

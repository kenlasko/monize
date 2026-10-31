"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Combobox } from "@/components/ui/Combobox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useReportData } from "@/hooks/useReportData";
import { useAuthStore } from "@/store/authStore";
import { accountsApi } from "@/lib/accounts";
import { categoriesApi } from "@/lib/categories";
import { payeesApi } from "@/lib/payees";
import { getCategorySelectOptions } from "@/lib/categoryUtils";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import type {
  SharedBankPaymentInput,
  SharedFinanceInput,
  SharedFinanceOverview,
  SharedFinancePreview,
  SharedGroupDetail,
} from "@/types/shared-expense";
import { SharedAmount, SharedError, SharedNotice } from "./SharedPrimitives";
import { SharedBankPaymentEditor } from "./SharedBankPaymentEditor";

export function SharedBooking({
  group,
  row,
  onClose,
  onSaved,
  initialInput,
  onPreview,
  onCommit,
}: {
  group: SharedGroupDetail;
  row: SharedFinanceOverview["entries"][number];
  onClose: () => void;
  onSaved: () => void;
  initialInput?: Partial<SharedFinanceInput>;
  onPreview?: (input: SharedFinanceInput) => Promise<SharedFinancePreview>;
  onCommit?: (
    input: SharedFinanceInput,
    preview: SharedFinancePreview,
  ) => Promise<void>;
}) {
  const t = useTranslations("sharedExpenses");
  const userId = useAuthStore((s) => s.user?.id);
  const options = useReportData(async () => {
    const [accounts, categories, payees] = await Promise.all([
      accountsApi.getAll(),
      categoriesApi.getAll(),
      payeesApi.getAll(),
    ]);
    return { accounts, categories, payees };
  }, []);
  const [input, setInput] = useState<SharedFinanceInput>(() => ({
    ...row.posting?.snapshot.input,
    ...initialInput,
    ...(Number(row.effect?.originalCash ?? "0") === 0
      ? {
          payments: undefined,
          bankAccountId: undefined,
          bankTransactionId: undefined,
          bankAmount: undefined,
          sharedBankAmount: undefined,
          bankRate: undefined,
          privateCategoryId: undefined,
          fxCategoryId: undefined,
          sourceSplits: undefined,
        }
      : {}),
    ...sharedCommand(row.revision),
    previewFingerprint: undefined,
  }));
  const [paymentIds, setPaymentIds] = useState(() =>
    (input.payments ?? [input]).map(() => crypto.randomUUID()),
  );
  const [preview, setPreview] = useState<{
    key: string;
    data: SharedFinancePreview;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [unlink, setUnlink] = useState(false);
  const [unlinkCommand] = useState(() =>
    sharedCommand(row.posting?.acceptedRevision ?? row.revision),
  );
  const key = JSON.stringify(input);
  const shown = preview?.key === key ? preview.data : null;
  const cash = row.effect && Number(row.effect.originalCash) !== 0;
  const accounts = options.data?.accounts.filter(
    (a) =>
      a.userId === userId &&
      !a.isClosed &&
      !a.managedPurpose &&
      ["CHEQUING", "SAVINGS", "CASH", "CREDIT_CARD", "LINE_OF_CREDIT"].includes(
        a.accountType,
      ),
  );
  const categoryOptions = getCategorySelectOptions(
    options.data?.categories ?? [],
    { includeEmpty: true, emptyLabel: t("choose") },
  );
  const change = (patch: Partial<SharedFinanceInput>) => {
    setInput({ ...input, ...patch });
    setError(null);
  };
  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview({
        key,
        data: await (onPreview
          ? onPreview(input)
          : sharedExpensesApi.previewFinance(group.id, row.entryId, input)),
      });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!shown) return;
    setBusy(true);
    setError(null);
    try {
      if (onCommit) await onCommit(input, shown);
      else
        await sharedExpensesApi.book(group.id, row.entryId, {
          ...input,
          previewFingerprint: shown.fingerprint,
        });
      onSaved();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.unlink(group.id, row.entryId, unlinkCommand);
      onSaved();
    } catch (cause) {
      setError(cause);
      setUnlink(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        pushHistory
        isOpen
        fixedHeight
        fullScreenOnPhone
        title={t(row.posting ? "reviewOwnFinances" : "book")}
        description={row.title}
        padding="md"
        maxWidth="2xl"
        onClose={busy ? undefined : onClose}
        footer={
          <>
            <Button disabled={busy} variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            {shown && !!error && (
              <Button variant="outline" disabled={busy} onClick={review}>
                {t("bookPreview")}
              </Button>
            )}
            {row.state !== "DRAFT" && (
              <Button
                isLoading={busy}
                disabled={!options.data || !!options.error}
                onClick={shown ? save : review}
              >
                {t(shown ? "acceptBooking" : "bookPreview")}
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          <SharedNotice>{t("bookHelp")}</SharedNotice>
          <SharedError
            error={error || options.error}
            retry={options.error ? options.reload : undefined}
          />
          {row.effect && Number(row.effect.personal) !== 0 && (
            <Combobox
              aria-label={t("category")}
              label={t("category")}
              placeholder={t("choose")}
              options={categoryOptions}
              value={input.categoryId ?? ""}
              onChange={(categoryId) =>
                change({ categoryId: categoryId || undefined })
              }
              usePortal
            />
          )}
          {!cash && row.effect && Number(row.effect.personal) !== 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("noBankPaymentHelp")}
            </p>
          )}
          {cash && (
            <div className="space-y-4">
              {(input.payments ?? [input]).map((payment, index) => (
                <Card
                  key={paymentIds[index]}
                  padding="sm"
                  className="space-y-3"
                >
                  <SharedBankPaymentEditor
                    originalBanks={row.posting?.originalBanks}
                    input={payment}
                    accounts={accounts ?? []}
                    categories={categoryOptions}
                    groupCurrency={group.currencyCode}
                    originalCurrency={row.effect!.originalCurrency}
                    multiple={!!input.payments}
                    onChange={(patch) =>
                      input.payments
                        ? change({
                            payments: input.payments.map((part, at) =>
                              at === index ? { ...part, ...patch } : part,
                            ),
                          })
                        : change(patch)
                    }
                  />
                  {input.payments && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        const remaining = input.payments!.filter(
                          (_, at) => at !== index,
                        );
                        setPaymentIds(
                          paymentIds.filter((_, at) => at !== index),
                        );
                        change(
                          remaining.length === 1
                            ? {
                                ...remaining[0],
                                contributionAmount: undefined,
                                payments: undefined,
                              }
                            : { payments: remaining },
                        );
                      }}
                    >
                      {t("removePayment")}
                    </Button>
                  )}
                </Card>
              ))}
              {input.payments && (
                <SharedNotice>{t("paymentsHelp")}</SharedNotice>
              )}
            </div>
          )}
          <details className="space-y-3">
            <summary className="min-h-10 cursor-pointer text-sm font-medium">
              {t("advanced")}
            </summary>
            {cash && (
              <>
                {(input.payments?.length ?? 1) < 10 && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      const {
                        contributionAmount,
                        bankAccountId,
                        bankTransactionId,
                        bankAmount,
                        sharedBankAmount,
                        bankRate,
                        privateCategoryId,
                        fxCategoryId,
                        sourceSplits,
                      } = input;
                      const current: SharedBankPaymentInput = {
                        contributionAmount,
                        bankAccountId,
                        bankTransactionId,
                        bankAmount,
                        sharedBankAmount,
                        bankRate,
                        privateCategoryId,
                        fxCategoryId,
                        sourceSplits,
                      };
                      change({
                        payments: [
                          ...(input.payments ?? [
                            {
                              ...current,
                              contributionAmount: String(
                                Math.abs(Number(row.effect!.originalCash)),
                              ),
                            },
                          ]),
                          {},
                        ],
                        contributionAmount: undefined,
                        bankAccountId: undefined,
                        sourceSplits: undefined,
                        bankTransactionId: undefined,
                        bankAmount: undefined,
                        sharedBankAmount: undefined,
                        bankRate: undefined,
                        privateCategoryId: undefined,
                        fxCategoryId: undefined,
                      });
                      setPaymentIds([...paymentIds, crypto.randomUUID()]);
                    }}
                  >
                    {t("addPayment")}
                  </Button>
                )}
              </>
            )}
            <Combobox
              aria-label={t("payee")}
              label={t("payee")}
              placeholder={t("choose")}
              options={(options.data?.payees ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              value={input.payeeId ?? ""}
              onChange={(payeeId) => change({ payeeId: payeeId || undefined })}
              usePortal
            />
          </details>
          {shown && (
            <Card padding="md">
              <h3 className="font-semibold mb-4">{t("currentBooking")}</h3>
              <dl className="space-y-3">
                {(
                  shown.payments ??
                  (shown.breakdown
                    ? [
                        {
                          breakdown: shown.breakdown,
                          bankCurrency: shown.bankCurrency!,
                          bankAccountId: "",
                        },
                      ]
                    : [])
                ).map((payment, index) => (
                  <div
                    key={index}
                    className="space-y-2 border-b border-gray-200 dark:border-gray-700 pb-3"
                  >
                    <dt className="font-medium">
                      {accounts?.find(
                        (account) => account.id === payment.bankAccountId,
                      )?.name ?? t("bankTransaction")}
                    </dt>
                    <BookingFigure
                      label={t("bankFlow")}
                      amount={payment.breakdown.bankTotal}
                      currency={payment.bankCurrency}
                      relativeTo={group.currencyCode}
                    />
                    <BookingFigure
                      label={t("privatePart")}
                      amount={payment.breakdown.privateRemainder}
                      currency={payment.bankCurrency}
                      relativeTo={group.currencyCode}
                    />
                    <BookingFigure
                      label={t("fxDifference")}
                      amount={payment.breakdown.fxDifference}
                      currency={payment.bankCurrency}
                      relativeTo={group.currencyCode}
                    />
                  </div>
                ))}
                <BookingFigure
                  label={t("personalFlow")}
                  amount={shown.effect.personal}
                  currency={group.currencyCode}
                />
                <BookingFigure
                  label={t("settlementChange")}
                  amount={shown.effect.position}
                  currency={group.currencyCode}
                />
                {shown.previous && (
                  <BookingFigure
                    label={t("previousBooking")}
                    amount={shown.previous.position}
                    currency={group.currencyCode}
                  />
                )}
              </dl>
            </Card>
          )}
          {row.posting && (
            <Button variant="ghost" onClick={() => setUnlink(true)}>
              {t("unlink")}
            </Button>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        isOpen={unlink}
        title={t("unlink")}
        message={t("unlinkHelp")}
        onConfirm={remove}
        onCancel={() => setUnlink(false)}
      />
    </>
  );
}
function BookingFigure({
  label,
  amount,
  currency,
  relativeTo,
}: {
  label: string;
  amount: string;
  currency: string;
  relativeTo?: string;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt>{label}</dt>
      <dd className="font-medium">
        <SharedAmount
          amount={amount}
          currency={currency}
          relativeTo={relativeTo}
        />
      </dd>
    </div>
  );
}

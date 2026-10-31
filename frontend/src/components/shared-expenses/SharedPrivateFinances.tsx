"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useReportData } from "@/hooks/useReportData";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import type { SharedFinanceOverview } from "@/types/shared-expense";
import { SharedAmount, SharedError, SharedNotice } from "./SharedPrimitives";

export function SharedPrivateFinances({
  initialGroupId,
  revision,
}: {
  initialGroupId?: string;
  revision?: number;
}) {
  const t = useTranslations("sharedExpenses");
  const groups = useReportData(sharedExpensesApi.privateGroups, []);
  const [selected, setSelected] = useState(initialGroupId ?? "");
  const id = selected || groups.data?.[0]?.groupId || "";
  const finances = useReportData(
    () => (id ? sharedExpensesApi.finances(id) : Promise.resolve(null)),
    [id, revision],
    { requestKey: id },
  );
  const [removing, setRemoving] = useState<{
    groupId: string;
    entry: SharedFinanceOverview["entries"][number];
    command: ReturnType<typeof sharedCommand>;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const data = finances.dataKey === id ? finances.data : null;
  const fresh =
    finances.dataKey === id &&
    !finances.isLoading &&
    !finances.error &&
    !groups.error;
  const unlink = async () => {
    if (!removing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.unlink(
        removing.groupId,
        removing.entry.entryId,
        removing.command,
      );
      setRemoving(null);
      finances.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <SharedNotice>{t("financialPrivacy")}</SharedNotice>
      <SharedError
        error={error || groups.error || finances.error}
        retry={() => {
          groups.reload();
          finances.reload();
        }}
      />
      <Select
        label={t("settlementAccount")}
        value={id}
        disabled={busy}
        onChange={(e) => setSelected(e.target.value)}
        options={(groups.data ?? []).map((group) => ({
          value: group.groupId,
          label: group.name,
        }))}
      />
      {data?.accessRevoked && <SharedNotice>{t("accessRevoked")}</SharedNotice>}
      {data?.integration && (
        <Link
          className="inline-block text-blue-600 dark:text-blue-400 hover:underline"
          href={`/accounts/${data.integration.accountId}`}
        >
          {t("openAccount")}
        </Link>
      )}
      {data && !data.accessRevoked && id && (
        <Link
          className="ml-4 inline-block text-blue-600 dark:text-blue-400 hover:underline"
          href={`/shared-expenses/${id}`}
        >
          {t("openGroup")}
        </Link>
      )}
      {data?.entries
        .filter((entry) => entry.posting)
        .map((entry) => (
          <Card key={entry.entryId} padding="sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium break-words">
                  {entry.title || t("acceptedSnapshot")}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("acceptedSnapshot")}
                </p>
              </div>
              <SharedAmount
                amount={entry.posting!.snapshot.effect.position}
                currency={data.integration!.currencyCode}
              />
              <Button
                variant="outline"
                disabled={!fresh || busy}
                onClick={() =>
                  setRemoving({
                    groupId: id,
                    entry,
                    command: sharedCommand(entry.posting!.acceptedRevision),
                  })
                }
              >
                {t("unlink")}
              </Button>
            </div>
          </Card>
        ))}
      {removing && (
        <ConfirmDialog
          isOpen
          title={t("unlink")}
          message={t("unlinkConfirm")}
          confirmLabel={t("unlink")}
          onConfirm={unlink}
          onCancel={() => !busy && setRemoving(null)}
        />
      )}
    </div>
  );
}

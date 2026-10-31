"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import { initialSharedEntry } from "@/lib/shared-split-draft";
import { useFinancialToday } from "@/hooks/useFinancialToday";
import type { SharedGroupDetail } from "@/types/shared-expense";
import { SharedSplitEditor } from "./SharedSplitEditor";
import { SharedError, SharedNotice } from "./SharedPrimitives";

export function SharedTemplate({
  group,
  onChanged,
}: {
  group: SharedGroupDetail;
  onChanged: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const today = useFinancialToday();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [command, setCommand] = useState(() => sharedCommand(group.revision));
  const save = async (splitTemplate: SharedGroupDetail["splitTemplate"]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.updateGroup(group.id, {
        ...command,
        splitTemplate,
      });
      setEditing(false);
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold mb-3">{t("defaultSplit")}</h2>
      <SharedNotice>{t("defaultSplitHelp")}</SharedNotice>
      <SharedError error={error} />
      <div className="flex flex-wrap gap-3 mt-3">
        <Button
          disabled={busy || !!group.archivedAt}
          onClick={() => {
            setCommand(sharedCommand(group.revision));
            setEditing(true);
          }}
        >
          {t("edit")}
        </Button>
        {group.splitTemplate && (
          <Button
            disabled={busy || !!group.archivedAt}
            variant="outline"
            onClick={() => save(null)}
          >
            {t("resetDefaultSplit")}
          </Button>
        )}
      </div>
      {editing && (
        <SharedSplitEditor
          groupId={group.id}
          template
          saveError={error}
          isSaving={busy}
          participants={group.participants.filter((p) => p.isActive)}
          places={group.decimalPlaces}
          input={{ ...initialSharedEntry(group, today), amount: "100" }}
          onClose={() => {
            if (!busy) setEditing(false);
          }}
          onApply={({ splitMode, shares }) => {
            if (splitMode !== "EXACT") void save({ mode: splitMode, shares });
          }}
        />
      )}
    </Card>
  );
}

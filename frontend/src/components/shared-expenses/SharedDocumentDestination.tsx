"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useReportData } from "@/hooks/useReportData";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedError } from "./SharedPrimitives";

export function SharedDocumentDestination({
  groupId,
  value,
  label,
  onChange,
}: {
  groupId: string;
  value: string | null;
  label: string | null;
  onChange: (id: string | null, title: string | null) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const key = `${groupId}:${search}:${offset}`;
  const data = useReportData(
    () =>
      sharedExpensesApi.group(groupId, offset, { search: search || undefined }),
    [key],
    { requestKey: key },
  );
  const fresh = data.dataKey === key && !data.error && !data.isLoading;
  return (
    <details className="text-sm space-y-3 mt-4">
      <summary className="cursor-pointer min-h-10">
        {t("fileParent", {
          name: value ? (label ?? t("entryFiles")) : t("directFiles"),
        })}
      </summary>
      <Button size="sm" variant="outline" onClick={() => onChange(null, null)}>
        {t("directFiles")}
      </Button>
      <form
        className="flex flex-wrap gap-2 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft);
          setOffset(0);
        }}
      >
        <Input
          label={t("searchEntries")}
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button variant="outline" type="submit">
          {t("search")}
        </Button>
      </form>
      <SharedError error={data.error} retry={data.reload} />
      <ul className="max-h-56 overflow-y-auto space-y-2">
        {data.data?.entries
          .filter((e) => e.canEdit)
          .map((e) => (
            <li key={e.id}>
              <Button
                disabled={!fresh}
                className="w-full text-left"
                size="sm"
                variant={e.id === value ? "primary" : "outline"}
                onClick={() => onChange(e.id, e.title)}
              >
                {e.title}
              </Button>
            </li>
          ))}
      </ul>
      <div className="flex gap-2 flex-wrap">
        <Button
          variant="outline"
          disabled={!fresh || !offset}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          {t("previousPage")}
        </Button>
        <Button
          variant="outline"
          disabled={!fresh || data.data?.nextOffset == null}
          onClick={() => setOffset(data.data!.nextOffset!)}
        >
          {t("loadMore")}
        </Button>
      </div>
    </details>
  );
}

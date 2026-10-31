"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useReportData } from "@/hooks/useReportData";
import { warrantiesApi } from "@/lib/warranties";
import { SharedError } from "./SharedPrimitives";

export function SharedWarrantyPicker({
  onChoose,
}: {
  onChoose: (id: string) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const [draft, setDraft] = useState("");
  const [q, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const key = `${q}:${page}`;
  const data = useReportData(
    () => warrantiesApi.list({ q, page, limit: 25 }),
    [key],
    { requestKey: key },
  );
  const fresh = !data.error && !data.isLoading && data.dataKey === key;
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft);
          setPage(1);
        }}
      >
        <Input
          label={t("searchWarranties")}
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button variant="outline" type="submit">
          {t("search")}
        </Button>
      </form>
      <SharedError error={data.error} retry={data.reload} />
      <ul className="max-h-64 overflow-y-auto space-y-2">
        {data.data?.data
          .filter((w) => w.documentCount > 0)
          .map((w) => (
            <li key={w.id}>
              <Button
                className="w-full text-left"
                variant="outline"
                disabled={!fresh}
                onClick={() => onChoose(w.id)}
              >
                {w.name}
              </Button>
            </li>
          ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!fresh || page === 1}
          onClick={() => setPage(page - 1)}
        >
          {t("previousPage")}
        </Button>
        <Button
          variant="outline"
          disabled={!fresh || page >= (data.data?.pagination.totalPages ?? 1)}
          onClick={() => setPage(page + 1)}
        >
          {t("loadMore")}
        </Button>
      </div>
    </div>
  );
}

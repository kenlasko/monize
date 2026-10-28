"use client";

import { useEffect, useState } from "react";
import { accrualsApi } from "@/lib/accruals";

/** Only visible, eligible source IDs; at most 100 IDs per request, no allocations. */
export function useAccrualBadges(sourceIds: string[], refreshKey: unknown) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([sourceIds, attempt]);
  const [result, setResult] = useState<{
    key: string;
    refreshKey: unknown;
    counts?: Map<string, number>;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ids: string[] = JSON.parse(key)[0];
    if (!ids.length) return;
    const load = async () => {
      const counts = new Map<string, number>();
      for (let offset = 0; offset < ids.length; offset += 100) {
        const rows = await accrualsApi.sources(ids.slice(offset, offset + 100));
        if (cancelled) return;
        for (const row of rows)
          counts.set(row.sourceTransactionId, row.scheduleCount);
      }
      if (!cancelled) setResult({ key, refreshKey, counts });
    };
    load().catch(() => {
      if (!cancelled) setResult({ key, refreshKey, failed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [key, refreshKey]);
  const current =
    result?.key === key && result.refreshKey === refreshKey ? result : null;
  return {
    counts: current?.counts,
    failed: current?.failed === true,
    retry: () => setAttempt((value) => value + 1),
  };
}

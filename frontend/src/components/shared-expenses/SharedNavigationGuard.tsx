"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/** Drafts/files stay in memory; warn before leaving instead of persisting private data. */
export function SharedNavigationGuard({
  when,
  message,
  guardBack = false,
}: {
  when: boolean;
  message: string;
  guardBack?: boolean;
}) {
  const t = useTranslations("sharedExpenses");
  const [pending, setPending] = useState<(() => void) | null>(null);
  const allow = useRef(false);
  useEffect(() => {
    if (!when) return;
    allow.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!allow.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const click = (event: MouseEvent) => {
      if (
        allow.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        link.target === "_blank" ||
        link.download ||
        link.href === window.location.href
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const href = link.href;
      setPending(() => () => window.location.assign(href));
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [when]);
  useEffect(() => {
    if (!when || !guardBack) return;
    // A local history entry identifier, not an authentication credential.
    const historyEntryId = crypto.randomUUID();
    const url = window.location.href;
    const push = () =>
      window.history.pushState(
        { ...window.history.state, sharedDraftGuard: historyEntryId },
        "",
        url,
      );
    push();
    const back = (event: PopStateEvent) => {
      if (allow.current) return;
      event.stopImmediatePropagation();
      push();
      setPending(() => () => window.history.go(-2));
    };
    window.addEventListener("popstate", back, true);
    return () => {
      window.removeEventListener("popstate", back, true);
      if (
        !allow.current &&
        window.history.state?.sharedDraftGuard === historyEntryId
      )
        window.history.back();
    };
  }, [when, guardBack]);
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={t("discardTitle")}
      message={message}
      confirmLabel={t("discard")}
      cancelLabel={t("keepEditing")}
      onCancel={() => setPending(null)}
      onConfirm={() => {
        allow.current = true;
        pending?.();
        setPending(null);
      }}
    />
  );
}

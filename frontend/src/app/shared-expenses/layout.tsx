"use client";

import { Fragment, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/store/authStore";
import { PageLayout } from "@/components/layout/PageLayout";
import { SharedNotice } from "@/components/shared-expenses/SharedPrimitives";

export default function SharedExpensesLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = useTranslations("sharedExpenses");
  const userId = useAuthStore((state) => state.user?.id);
  const actingAs = useAuthStore((state) => state.actingAsUserId);
  if (actingAs)
    return (
      <PageLayout>
        <SharedNotice>{t("ownContextOnly")}</SharedNotice>
      </PageLayout>
    );
  // Changing identity discards all in-memory drafts, file selections and responses.
  return <Fragment key={userId}>{children}</Fragment>;
}

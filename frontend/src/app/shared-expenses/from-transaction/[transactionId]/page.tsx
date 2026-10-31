"use client";

import { useTranslations } from "next-intl";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { SharedNotice } from "@/components/shared-expenses/SharedPrimitives";

export default function SharedFromTransactionPage() {
  const t = useTranslations("sharedExpenses");
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
          <PageHeader title={t("title")} />
          <SharedNotice>{t("financeDeferred")}</SharedNotice>
          <ButtonLink href="/shared-expenses">{t("groups")}</ButtonLink>
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}

"use client";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { SharedPrivateFinances } from "@/components/shared-expenses/SharedPrivateFinances";

export default function PrivateSharedBookingsPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const t = useTranslations("sharedExpenses");
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
          <PageHeader title={t("retainedFinance")} />
          <SharedPrivateFinances initialGroupId={groupId} />
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}

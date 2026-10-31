"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { SharedPeople } from "@/components/shared-expenses/SharedPeople";

export default function LinkedPeoplePage() {
  const t = useTranslations("sharedExpenses");
  const { payeeId } = useParams<{ payeeId: string }>();
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 space-y-5">
          <PageHeader
            title={t("linkedPeople")}
            actions={
              <ButtonLink href="/shared-expenses" variant="outline">
                {t("title")}
              </ButtonLink>
            }
          />
          <SharedPeople key={payeeId} linkedPayeeId={payeeId} />
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { useAuthStore } from "@/store/authStore";
import { useReportData } from "@/hooks/useReportData";
import { authApi } from "@/lib/auth";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  SharedError,
  SharedNotice,
} from "@/components/shared-expenses/SharedPrimitives";

export default function SharedJoinPage() {
  const t = useTranslations("sharedExpenses");
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const [error, setError] = useState<unknown>(null);
  const check = async () => {
    try {
      const user = await authApi.getProfile();
      if (user) useAuthStore.getState().setUser(user);
    } catch (cause) {
      setError(cause);
    }
  };
  // Keep a logged-out invitation in this tab. Its capability stays in the URL
  // fragment; it never enters login query strings, server logs or browser storage.
  return authenticated ? (
    <ProtectedRoute>
      <JoinContent />
    </ProtectedRoute>
  ) : (
    <PageLayout>
      <main className="mx-auto max-w-lg px-4 py-8">
        <PageHeader title={t("joinTitle")} />
        <Card padding="md">
          <p>{t("signInToJoin")}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/login"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 underline"
            >
              {t("signIn")}
            </Link>
            <Button onClick={check}>{t("refresh")}</Button>
          </div>
          <SharedError error={error} />
        </Card>
      </main>
    </PageLayout>
  );
}
function JoinContent() {
  const t = useTranslations("sharedExpenses");
  const router = useRouter();
  const invite = useReportData(async () => {
    const token = window.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(t("invalidInvite"));
    return { token, ...(await sharedExpensesApi.inspect(token)) };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const join = async () => {
    if (!invite.data) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sharedExpensesApi.claim(invite.data.token);
      router.replace(`/shared-expenses/${result.id}`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageLayout>
      <main className="mx-auto max-w-lg px-4 py-8">
        <PageHeader title={t("joinTitle")} />
        <Card padding="md">
          <div className="space-y-5">
            <SharedError
              error={error || invite.error}
              retry={invite.error ? invite.reload : undefined}
            />
            {invite.isLoading && <LoadingSpinner />}
            {invite.data && (
              <>
                <h2 className="text-xl font-semibold">
                  {t("joinAs", {
                    group: invite.data.groupName,
                    person: invite.data.participantName,
                  })}
                </h2>
                <p>{t(invite.data.role)}</p>
                <SharedNotice>{t("joinPrivacy")}</SharedNotice>
                <Button isLoading={busy} onClick={join}>
                  {t("join")}
                </Button>
              </>
            )}
          </div>
        </Card>
      </main>
    </PageLayout>
  );
}

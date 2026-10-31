"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { TOUR_ANCHORS, tourAnchor } from "@/lib/tours/anchors";
import { docsUrl } from "@/lib/docs-links";
import {
  ArrowPathIcon,
  UsersIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { useReportData } from "@/hooks/useReportData";
import { SharedGroupTable } from "@/components/shared-expenses/SharedGroupTable";
import { SharedOverviewSummary } from "@/components/shared-expenses/SharedOverviewSummary";
import { ListTopToolbar } from "@/components/ui/ListTopToolbar";
import { ListBottomPager } from "@/components/ui/ListBottomPager";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  SharedError,
  SharedTabs,
} from "@/components/shared-expenses/SharedPrimitives";
const SharedGroupForm = dynamic(
  () =>
    import("@/components/shared-expenses/SharedGroupForm").then(
      (m) => m.SharedGroupForm,
    ),
  { ssr: false },
);
const SharedPeople = dynamic(() =>
  import("@/components/shared-expenses/SharedPeople").then(
    (m) => m.SharedPeople,
  ),
);
const SharedPrivateFinances = dynamic(() =>
  import("@/components/shared-expenses/SharedPrivateFinances").then(
    (m) => m.SharedPrivateFinances,
  ),
);

export default function SharedExpensesPage() {
  return (
    <ProtectedRoute>
      <GroupsContent />
    </ProtectedRoute>
  );
}
function GroupsContent() {
  const t = useTranslations("sharedExpenses");
  const router = useRouter();
  const groups = useReportData(sharedExpensesApi.overview, []);
  const privateGroups = useReportData(sharedExpensesApi.privateGroups, []);
  const [form, setForm] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<"groups" | "people" | "retainedFinance">(
    "groups",
  );
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const visible = groups.data?.groups.filter(
    (group) =>
      !!group.archivedAt === (filter === "archived") &&
      group.name.toLowerCase().includes(query.toLowerCase()),
  );
  const totalPages = Math.max(1, Math.ceil((visible?.length ?? 0) / 25));
  const currentPage = Math.min(page, totalPages);
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8 space-y-5">
        <PageHeader
          title={t("title")}
          helpUrl={docsUrl("sharedExpenses")}
          subtitle={t("subtitle")}
          actions={
            <div className="flex flex-wrap items-stretch gap-2">
              <Button
                variant="outline"
                onClick={groups.reload}
                aria-label={t("refresh")}
                disabled={groups.isLoading}
              >
                <ArrowPathIcon className="h-5 w-5" aria-hidden="true" />
              </Button>
              <Button
                {...tourAnchor(TOUR_ANCHORS.sharedNewGroup)}
                onClick={() => setForm(true)}
              >
                <PlusIcon className="mr-2 h-5 w-5" aria-hidden="true" />
                {t("newGroup")}
              </Button>
            </div>
          }
        />
        {groups.data && <SharedOverviewSummary overview={groups.data} />}
        <Tabs
          idPrefix="shared-overview"
          ariaLabel={t("title")}
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "groups", label: t("groups") },
            { key: "people", label: t("people") },
            ...(privateGroups.data?.length
              ? [
                  {
                    key: "retainedFinance" as const,
                    label: t("retainedFinance"),
                  },
                ]
              : []),
          ]}
        />
        <SharedError error={privateGroups.error} retry={privateGroups.reload} />
        <TabPanel
          idPrefix="shared-overview"
          tabKey="retainedFinance"
          isActive={tab === "retainedFinance"}
          className="pt-4"
        >
          <SharedPrivateFinances />
        </TabPanel>
        <TabPanel
          idPrefix="shared-overview"
          tabKey="people"
          isActive={tab === "people"}
          className="pt-4"
        >
          <SharedPeople />
        </TabPanel>
        <TabPanel
          idPrefix="shared-overview"
          tabKey="groups"
          isActive={tab === "groups"}
          className="pt-4 space-y-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-full sm:w-80">
              <Input
                aria-label={t("searchGroups")}
                placeholder={t("searchGroups")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
            </div>
            <SharedTabs
              label={t("groups")}
              value={filter}
              onChange={(value) => {
                setFilter(value);
                setPage(1);
              }}
              options={(["active", "archived"] as const).map((value) => ({
                value,
                label: groups.data
                  ? t("statusCount", {
                      status: t(value),
                      count: groups.data.groups.filter(
                        (group) =>
                          !!group.archivedAt === (value === "archived"),
                      ).length,
                    })
                  : t(value),
              }))}
            />
          </div>
          <SharedError error={groups.error} retry={groups.reload} />
          <div
            {...(!groups.isLoading && tourAnchor(TOUR_ANCHORS.sharedGroupList))}
            className="space-y-4"
          >
            {groups.isLoading && !groups.data ? (
              <LoadingSpinner />
            ) : groups.data &&
              !groups.error &&
              !groups.isLoading &&
              !visible?.length ? (
              <Card>
                <EmptyState
                  icon={<UsersIcon />}
                  title={t("emptyGroups")}
                  description={t("emptyGroupsHelp")}
                  action={
                    <Button onClick={() => setForm(true)}>
                      {t("newGroup")}
                    </Button>
                  }
                />
              </Card>
            ) : groups.data ? (
              <>
                <SharedGroupTable
                  toolbar={
                    <ListTopToolbar
                      currentPage={currentPage}
                      totalPages={totalPages}
                      totalItems={visible?.length ?? 0}
                      pageSize={25}
                      onPageChange={setPage}
                      itemName={t("groups")}
                    />
                  }
                  groups={(visible ?? []).slice(
                    (currentPage - 1) * 25,
                    currentPage * 25,
                  )}
                  fresh={!groups.isLoading && !groups.error}
                  onOpen={(id) => router.push(`/shared-expenses/${id}`)}
                />
                <ListBottomPager
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={visible?.length ?? 0}
                  pageSize={25}
                  onPageChange={setPage}
                  itemName={t("groups")}
                  totalLabel={t("groupCount", { count: visible?.length ?? 0 })}
                />
              </>
            ) : null}
          </div>
        </TabPanel>
        {form && (
          <SharedGroupForm
            onClose={() => setForm(false)}
            onCreated={(id) => router.push(`/shared-expenses/${id}`)}
          />
        )}
      </main>
    </PageLayout>
  );
}

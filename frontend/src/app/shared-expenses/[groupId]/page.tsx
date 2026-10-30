"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { SharedAddEntryButton } from "@/components/shared-expenses/SharedAddEntryButton";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { EntitySwitcher } from "@/components/ui/EntitySwitcher";
import { Input } from "@/components/ui/Input";
import { DateInput } from "@/components/ui/DateInput";
import { Select } from "@/components/ui/Select";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useReportData } from "@/hooks/useReportData";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { exportCsvSections } from "@/lib/csv-export";
import type {
  SharedEntry,
  SharedEntryType,
  SharedSuggestion,
} from "@/types/shared-expense";
import {
  SharedError,
  SharedNotice,
} from "@/components/shared-expenses/SharedPrimitives";
const SharedEntryEditor = dynamic(
  () =>
    import("@/components/shared-expenses/SharedEntryEditor").then(
      (m) => m.SharedEntryEditor,
    ),
  { ssr: false },
);
const SharedEntryDetail = dynamic(
  () =>
    import("@/components/shared-expenses/SharedEntryDetail").then(
      (m) => m.SharedEntryDetail,
    ),
  { ssr: false },
);
const SharedBalances = dynamic(() =>
  import("@/components/shared-expenses/SharedBalances").then(
    (m) => m.SharedBalances,
  ),
);
const SharedDocuments = dynamic(
  () =>
    import("@/components/shared-expenses/SharedDocuments").then(
      (m) => m.SharedDocuments,
    ),
  { ssr: false },
);
const SharedSettings = dynamic(() =>
  import("@/components/shared-expenses/SharedSettings").then(
    (m) => m.SharedSettings,
  ),
);
const SharedFinances = dynamic(() =>
  import("@/components/shared-expenses/SharedFinances").then(
    (m) => m.SharedFinances,
  ),
);
const SharedActivity = dynamic(() =>
  import("@/components/shared-expenses/SharedActivity").then(
    (m) => m.SharedActivity,
  ),
);
import { SharedGroupSummary } from "@/components/shared-expenses/SharedGroupSummary";
import { TOUR_ANCHORS, tourAnchor } from "@/lib/tours/anchors";
import { docsUrl } from "@/lib/docs-links";
import { SharedEntryTable } from "@/components/shared-expenses/SharedEntryTable";
import { SharedFilters } from "@/components/shared-expenses/SharedFilters";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import {
  ListTopToolbar,
  LIST_TOOLBAR_BUTTON_CLASS,
} from "@/components/ui/ListTopToolbar";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ListBottomPager } from "@/components/ui/ListBottomPager";
import type { SharedDocument } from "@/lib/shared-documents";

const TABS = [
  "expenses",
  "balances",
  "files",
  "activity",
  "myFinances",
  "settings",
] as const;

export default function SharedGroupPage() {
  const { groupId } = useParams<{ groupId: string }>();
  return (
    <ProtectedRoute>
      <Suspense fallback={<LoadingSpinner />}>
        <GroupContent key={groupId} groupId={groupId} />
      </Suspense>
    </ProtectedRoute>
  );
}
function GroupContent({ groupId }: { groupId: string }) {
  const searchParams = useSearchParams();
  const t = useTranslations("sharedExpenses");
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const [pendingFiles, setPendingFiles] = useState(false);
  const [nextTab, setNextTab] = useState<(typeof TABS)[number] | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>(() =>
    searchParams.get("view") === "myFinances" ? "myFinances" : "expenses",
  );
  const [searchDraft, setSearchDraft] = useState("");
  const search = useDebouncedValue(searchDraft, 400);
  const [type, setType] = useState("");
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({
    participantId: "",
    startDate: "",
    endDate: "",
  });
  const key = JSON.stringify({ groupId, offset, search, type, filters });
  const data = useReportData(
    () =>
      sharedExpensesApi.group(groupId, offset, {
        search: search || undefined,
        type: type || undefined,
        participantId: filters.participantId || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      }),
    [key],
    { requestKey: key },
  );
  const groups = useReportData(sharedExpensesApi.groups, []);
  const group = data.data?.id === groupId ? data.data : null;
  const fresh =
    search === searchDraft &&
    data.dataKey === key &&
    !data.error &&
    !data.isLoading;
  const [detail, setDetail] = useState<SharedEntry | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [entryError, setEntryError] = useState<unknown>(null);
  const openUnresolved = async (id: string) => {
    if (entryLoading) return;
    setEntryLoading(true);
    setEntryError(null);
    try {
      setDetail(await sharedExpensesApi.entry(groupId, id));
    } catch (cause) {
      setEntryError(cause);
    } finally {
      setEntryLoading(false);
    }
  };
  const [form, setForm] = useState<{
    kind: SharedEntryType;
    entry?: SharedEntry;
    suggestion?: SharedSuggestion;
    refundSource?: SharedEntry;
    sourceDocument?: SharedDocument;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);
  const changed = () => {
    data.reload();
    groups.reload();
  };
  const download = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const result = await sharedExpensesApi.export(groupId);
      exportCsvSections(result.group.name, [
        {
          title: result.group.name,
          headers: [
            t("entryTitle"),
            t("date"),
            t("amount"),
            t("currency"),
            t("review"),
            t("note"),
            t("entryType"),
            t("groupAmount"),
            t("groupCurrency"),
            t("fxRate"),
            t("fxSource"),
            t("fxRateDate"),
            t("revision"),
            t("from"),
            t("to"),
          ],
          rows: result.entries.map((e) => [
            e.title,
            e.date,
            e.originalAmount,
            e.currencyCode,
            t(e.state),
            e.note,
            t(e.type),
            e.groupAmount,
            result.group.currencyCode,
            e.fxRate,
            e.fxSource ? t(e.fxSource) : "",
            e.fxRateDate,
            e.revision,
            result.participants.find((p) => p.id === e.fromParticipantId)?.name,
            result.participants.find((p) => p.id === e.toParticipantId)?.name,
          ]),
        },
        {
          title: t("exportAllocations"),
          headers: [
            t("entryTitle"),
            t("participants"),
            t("review"),
            t("amount"),
            t("currency"),
          ],
          rows: result.entries.flatMap((e) =>
            e.allocations.map((a) => [
              e.title,
              result.participants.find((p) => p.id === a.participantId)?.name,
              t(a.kind === "SHARE" ? "cost" : "paid"),
              a.originalAmount,
              e.currencyCode,
            ]),
          ),
        },
        {
          title: t("positions"),
          headers: [t("participants"), t("yourBalance"), t("currency")],
          rows: result.balances.positions.map((p) => [
            result.participants.find((person) => person.id === p.participantId)
              ?.name,
            p.balance,
            result.group.currencyCode,
          ]),
        },
      ]);
    } catch (cause) {
      setExportError(cause);
    } finally {
      setExporting(false);
    }
  };
  const myPosition = group?.balances.positions.find(
    (p) => p.participantId === group.myParticipantId,
  );
  const writable = group && !group.archivedAt && group.role !== "VIEWER";
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8 space-y-5">
        <Link
          href="/shared-expenses"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ChevronLeftIcon className="h-4 w-4" />
          {t("back")}
        </Link>
        <SharedError error={data.error} retry={data.reload} />
        <SharedError error={exportError || entryError} />
        {!group && data.isLoading && <LoadingSpinner />}
        {group && (
          <>
            <PageHeader
              title={group.name}
              helpUrl={docsUrl("sharedExpenses")}
              subtitle={group.description ?? undefined}
              titleAdornment={
                <EntitySwitcher
                  currentId={group.id}
                  items={(groups.data ?? []).map((g) => ({
                    id: g.id,
                    primary: g.name,
                  }))}
                  onSelect={(id) => router.push(`/shared-expenses/${id}`)}
                  triggerLabel={t("groups")}
                  filterPlaceholder={t("search")}
                  noMatchesLabel={t("emptyGroups")}
                />
              }
              actions={
                <div
                  {...tourAnchor(TOUR_ANCHORS.sharedGroupActions)}
                  className="flex flex-wrap items-stretch gap-2"
                >
                  <Button
                    variant="outline"
                    onClick={changed}
                    aria-label={t("refresh")}
                  >
                    <ArrowPathIcon aria-hidden="true" className="h-5 w-5" />
                  </Button>
                  {writable && (
                    <SharedAddEntryButton
                      disabled={!fresh}
                      onAdd={(kind) => setForm({ kind })}
                    />
                  )}
                </div>
              }
            />
            {group.isDetachedCopy && (
              <SharedNotice>{t("detachedCopyHelp")}</SharedNotice>
            )}
            {group.archivedAt && (
              <SharedNotice>{t("archiveHelp")}</SharedNotice>
            )}
            {group.role === "VIEWER" && (
              <SharedNotice>{t("readOnly")}</SharedNotice>
            )}
            <SharedGroupSummary group={group} />
            {!group.balances.settlementReady && (
              <div className="space-y-2">
                <SharedNotice>{t("missingRate")}</SharedNotice>
                {myPosition && (
                  <p className="text-sm">
                    {t("partialBalance", {
                      amount: formatCurrency(
                        Number(myPosition.knownBalance),
                        group.currencyCode,
                      ),
                    })}
                  </p>
                )}
                <ul className="space-y-1">
                  {group.unresolvedEntries?.map((entry) => (
                    <li key={entry.id}>
                      <Button
                        variant="ghost"
                        disabled={entryLoading}
                        onClick={() => openUnresolved(entry.id)}
                      >
                        {entry.title} · {entry.currencyCode} →{" "}
                        {group.currencyCode} · {formatDate(entry.date)}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Tabs
              anchorProps={tourAnchor(TOUR_ANCHORS.sharedGroupTabs)}
              idPrefix="shared-group"
              value={tab}
              onChange={(value) => {
                if (pendingFiles && value !== tab) setNextTab(value);
                else setTab(value);
              }}
              ariaLabel={t("title")}
              tabs={TABS.filter((value) => value !== "myFinances").map(
                (value) => ({ key: value, label: t(value) }),
              )}
            />
            <TabPanel
              idPrefix="shared-group"
              tabKey="expenses"
              isActive={tab === "expenses"}
              className="pt-4 space-y-4"
            >
              <SharedFilters
                onClear={() => {
                  setSearchDraft("");
                  setType("");
                  setFilters({
                    participantId: "",
                    startDate: "",
                    endDate: "",
                  });
                  setOffset(0);
                }}
                chips={[
                  ...(search
                    ? [
                        {
                          key: "search",
                          label: search,
                          removeLabel: t("removeFilter", {
                            filter: t("search"),
                          }),
                          remove: () => {
                            setSearchDraft("");
                            setOffset(0);
                          },
                        },
                      ]
                    : []),
                  ...(type
                    ? [
                        {
                          key: "type",
                          label: t(type),
                          removeLabel: t("removeFilter", {
                            filter: t("entryType"),
                          }),
                          remove: () => {
                            setType("");
                            setOffset(0);
                          },
                        },
                      ]
                    : []),
                  ...(["participantId", "startDate", "endDate"] as const)
                    .filter((key) => filters[key])
                    .map((key) => ({
                      key,
                      label:
                        key === "participantId"
                          ? (group.participants.find(
                              (p) => p.id === filters[key],
                            )?.name ?? t("participants"))
                          : t("filterValue", {
                              filter: t(key),
                              value: formatDate(filters[key]),
                            }),
                      removeLabel: t("removeFilter", {
                        filter: t(
                          key === "participantId" ? "participants" : key,
                        ),
                      }),
                      remove: () => {
                        setFilters({ ...filters, [key]: "" });
                        setOffset(0);
                      },
                    })),
                ]}
              >
                <div className="mb-4">
                  <Input
                    aria-label={t("searchEntries")}
                    placeholder={t("searchEntries")}
                    value={searchDraft}
                    maxLength={200}
                    onChange={(event) => {
                      setSearchDraft(event.target.value);
                      setOffset(0);
                    }}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Select
                    label={t("entryType")}
                    value={type}
                    options={[
                      { value: "", label: t("all") },
                      ...(
                        ["EXPENSE", "REFUND", "INCOME", "REPAYMENT"] as const
                      ).map((value) => ({ value, label: t(value) })),
                    ]}
                    onChange={(e) => {
                      setType(e.target.value);
                      setOffset(0);
                    }}
                  />
                  <Select
                    label={t("participants")}
                    value={filters.participantId}
                    options={[
                      { value: "", label: t("all") },
                      ...group.participants.map((p) => ({
                        value: p.id,
                        label: p.name,
                      })),
                    ]}
                    onChange={(e) => {
                      setFilters({
                        ...filters,
                        participantId: e.target.value,
                      });
                      setOffset(0);
                    }}
                  />
                  <DateInput
                    label={t("startDate")}
                    value={filters.startDate}
                    onDateChange={(startDate) => {
                      setFilters({ ...filters, startDate });
                      setOffset(0);
                    }}
                  />
                  <DateInput
                    label={t("endDate")}
                    value={filters.endDate}
                    onDateChange={(endDate) => {
                      setFilters({ ...filters, endDate });
                      setOffset(0);
                    }}
                  />
                </div>
              </SharedFilters>
              <SharedEntryTable
                group={group}
                fresh={fresh}
                onOpen={setDetail}
                emptyState={
                  fresh ? (
                    <EmptyState
                      icon={<UsersIcon />}
                      title={t("emptyEntries")}
                      description={t("emptyEntriesHelp")}
                    />
                  ) : undefined
                }
                toolbar={
                  <fieldset disabled={!fresh} aria-busy={!fresh}>
                    <ListTopToolbar
                      {...(group.entryCount > 0
                        ? {
                            currentPage: Math.floor(offset / 100) + 1,
                            totalPages: Math.max(
                              1,
                              Math.ceil(group.entryCount / 100),
                            ),
                            totalItems: group.entryCount,
                            pageSize: 100,
                            onPageChange: (page: number) => {
                              if (fresh) setOffset((page - 1) * 100);
                            },
                          }
                        : {})}
                      itemName={t("expenses")}
                      actions={
                        <button
                          type="button"
                          className={LIST_TOOLBAR_BUTTON_CLASS}
                          disabled={!fresh || exporting}
                          onClick={download}
                          aria-busy={exporting}
                        >
                          {exporting ? t("loading") : t("export")}
                        </button>
                      }
                    />
                  </fieldset>
                }
              />
              <fieldset disabled={!fresh} aria-busy={!fresh}>
                <ListBottomPager
                  currentPage={Math.floor(offset / 100) + 1}
                  totalPages={Math.max(1, Math.ceil(group.entryCount / 100))}
                  totalItems={group.entryCount}
                  pageSize={100}
                  onPageChange={(page) => {
                    if (fresh) setOffset((page - 1) * 100);
                  }}
                  itemName={t("expenses")}
                  totalLabel={t("entryCount", { count: group.entryCount })}
                />
              </fieldset>
            </TabPanel>
            <TabPanel
              idPrefix="shared-group"
              tabKey="balances"
              isActive={tab === "balances"}
              className="pt-4"
            >
              <SharedBalances
                group={group}
                onRepay={(suggestion) =>
                  setForm({ kind: "REPAYMENT", suggestion })
                }
              />
            </TabPanel>
            <TabPanel
              idPrefix="shared-group"
              tabKey="files"
              isActive={tab === "files"}
              className="pt-4"
            >
              <SharedDocuments
                key={group.id}
                onPendingChange={setPendingFiles}
                group={group}
                onOpenEntry={openUnresolved}
                onCreateEntry={(sourceDocument) =>
                  setForm({ kind: "EXPENSE", sourceDocument })
                }
              />
            </TabPanel>
            <TabPanel
              idPrefix="shared-group"
              tabKey="myFinances"
              isActive={tab === "myFinances"}
              className="pt-4"
            >
              <SharedFinances
                key={group.id}
                group={group}
                onOpenEntry={openUnresolved}
              />
            </TabPanel>
            <TabPanel
              idPrefix="shared-group"
              tabKey="settings"
              isActive={tab === "settings"}
              className="pt-4"
            >
              <SharedSettings
                key={group.id}
                group={group}
                onChanged={changed}
              />
            </TabPanel>
            <TabPanel
              idPrefix="shared-group"
              tabKey="activity"
              isActive={tab === "activity"}
              className="pt-4"
            >
              <SharedActivity key={group.revision} group={group} />
            </TabPanel>
            {detail && (
              <SharedEntryDetail
                key={detail.id}
                entry={detail}
                group={group}
                onClose={() => setDetail(null)}
                onChanged={changed}
                onEdit={() => {
                  setForm({ kind: detail.type, entry: detail });
                  setDetail(null);
                }}
                onRefund={() => {
                  setForm({ kind: "REFUND", refundSource: detail });
                  setDetail(null);
                }}
              />
            )}
            {form && (
              <SharedEntryEditor
                key={form.entry?.id ?? `${form.kind}:new`}
                group={group}
                {...form}
                onClose={() => setForm(null)}
                onSaved={changed}
              />
            )}
          </>
        )}
        <ConfirmDialog
          isOpen={nextTab !== null}
          title={t("discardTitle")}
          message={t("pendingFilesLeave")}
          confirmLabel={t("discard")}
          onCancel={() => setNextTab(null)}
          onConfirm={() => {
            if (nextTab) setTab(nextTab);
            setNextTab(null);
            setPendingFiles(false);
          }}
        />
      </main>
    </PageLayout>
  );
}

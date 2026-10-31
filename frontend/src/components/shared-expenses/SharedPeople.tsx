"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Combobox } from "@/components/ui/Combobox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormActions } from "@/components/ui/FormActions";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { useReportData } from "@/hooks/useReportData";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { payeesApi } from "@/lib/payees";
import type { SharedPerson } from "@/types/shared-expense";
import { SharedAmount, SharedError, SharedNotice } from "./SharedPrimitives";

export function SharedPeople({
  linkedPayeeId,
}: { linkedPayeeId?: string } = {}) {
  const t = useTranslations("sharedExpenses");
  const people = useReportData(sharedExpensesApi.people, []);
  const payees = useReportData(() => payeesApi.getAll(), []);
  const [edit, setEdit] = useState<SharedPerson | "new" | null>(null);
  const [remove, setRemove] = useState<SharedPerson | null>(null);
  const [name, setName] = useState("");
  const [payeeId, setPayee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sharedExpensesApi.savePerson(
        { name, payeeId: payeeId || undefined },
        edit && edit !== "new" ? edit.id : undefined,
      );
      setEdit(null);
      people.reload();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const visible = people.data?.filter(
    (person) => !linkedPayeeId || person.payeeId === linkedPayeeId,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <Badge>{t("privateOnly")}</Badge>
        <Button
          className="sm:ml-auto"
          onClick={() => {
            setEdit("new");
            setName(
              payees.data?.find((p) => p.id === linkedPayeeId)?.name ?? "",
            );
            setPayee(linkedPayeeId ?? "");
          }}
        >
          {t("newContact")}
        </Button>
      </div>
      <SharedNotice>{t("personHelp")}</SharedNotice>
      <SharedError error={people.error} retry={people.reload} />
      {visible?.length === 0 && (
        <EmptyState title={t("noPeople")} description={t("noPeopleHelp")} />
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {visible?.map((person) => (
          <Card key={person.id} padding="none" className="p-6">
            <div className="flex justify-between gap-2">
              <h2 className="font-semibold break-words">{person.name}</h2>
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEdit(person);
                    setName(person.name);
                    setPayee(person.payeeId ?? "");
                  }}
                >
                  {t("edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setRemove(person);
                  }}
                >
                  {t("deleteContact")}
                </Button>
              </div>
            </div>
            <ul className="space-y-2 mt-3">
              {person.groups.map((group) => (
                <li
                  key={group.groupId}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <Link
                    href={`/shared-expenses/${group.groupId}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {group.groupName}
                  </Link>
                  <SharedAmount
                    amount={group.position.balance}
                    currency={group.currencyCode}
                  />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <SharedError error={!edit ? error : null} />
      <ConfirmDialog
        isOpen={!!remove}
        title={t("deleteContact")}
        message={t("deleteContactHelp")}
        onCancel={() => {
          if (!busy) setRemove(null);
        }}
        onConfirm={async () => {
          if (!remove || busy) return;
          setBusy(true);
          setError(null);
          try {
            await sharedExpensesApi.deletePerson(remove.id);
            setRemove(null);
            people.reload();
          } catch (cause) {
            setError(cause);
            setRemove(null);
          } finally {
            setBusy(false);
          }
        }}
      />
      {edit && (
        <Modal
          isOpen
          title={t("savePerson")}
          padding="none"
          className="p-6"
          maxWidth="md"
          onClose={busy ? undefined : () => setEdit(null)}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && name.trim()) void save();
            }}
          >
            <SharedError error={error || payees.error} />
            <Input
              label={t("contactName")}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
            <Combobox
              aria-label={t("payee")}
              label={t("payee")}
              placeholder={t("choose")}
              options={(payees.data ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              value={payeeId}
              onChange={setPayee}
              usePortal
            />
            <SharedNotice>{t("privateOnly")}</SharedNotice>
            <FormActions
              onCancel={() => setEdit(null)}
              submitLabel={t("save")}
              isSubmitting={busy}
              submitDisabled={!name.trim()}
            />
          </form>
        </Modal>
      )}
    </div>
  );
}

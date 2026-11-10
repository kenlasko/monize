"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, HOVER_ROW_ON_CARD } from "@/components/ui/Card";
import {
  CellLabel,
  CAPTION_CLASS,
  TABLE_CLASS,
  TABLE_BODY_CLASS,
  Th,
  Td,
} from "@/components/ui/Table";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Combobox } from "@/components/ui/Combobox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormActions } from "@/components/ui/FormActions";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { useReportData } from "@/hooks/useReportData";
import { useMobileAddAction } from "@/store/mobileAddActionStore";
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
  const startNew = () => {
    setEdit("new");
    setName(payees.data?.find((p) => p.id === linkedPayeeId)?.name ?? "");
    setPayee(linkedPayeeId ?? "");
  };
  useMobileAddAction(t("newContact"), startNew);
  const payeeNames = new Map(
    (payees.data ?? []).map((payee) => [payee.id, payee.name]),
  );
  const visible = people.data?.filter(
    (person) => !linkedPayeeId || person.payeeId === linkedPayeeId,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <Badge>{t("privateOnly")}</Badge>
        <Button className="sm:ml-auto" onClick={startNew}>
          {t("newContact")}
        </Button>
      </div>
      <SharedNotice>{t("personHelp")}</SharedNotice>
      <SharedError error={people.error} retry={people.reload} />
      {visible?.length === 0 && (
        <EmptyState title={t("noPeople")} description={t("noPeopleHelp")} help="sharedExpenses" />
      )}
      {!!visible?.length && (
        <Card className="overflow-hidden">
          <table
            role="table"
            aria-label={t("people")}
            className={`${TABLE_CLASS} block sm:table w-full`}
          >
            <thead role="rowgroup" className="hidden sm:table-header-group">
              <tr role="row">
                <Th>{t("contactName")}</Th>
                <Th>{t("linkedPayee")}</Th>
                <Th>{t("groups")}</Th>
                <Th align="right">
                  <span className="sr-only">{t("actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody
              role="rowgroup"
              className={`${TABLE_BODY_CLASS} block sm:table-row-group`}
            >
              {visible.map((person) => {
                const payee = person.payeeId
                  ? payeeNames.get(person.payeeId)
                  : undefined;
                return (
                  <tr
                    key={person.id}
                    role="row"
                    className={`grid grid-cols-2 sm:table-row ${HOVER_ROW_ON_CARD}`}
                  >
                    <Td
                      role="cell"
                      className="col-start-1 row-start-1 min-w-0 break-words sm:break-normal align-top"
                    >
                      <span className="font-medium">{person.name}</span>
                    </Td>
                    <Td
                      role="cell"
                      className="col-start-1 col-span-2 row-start-2 min-w-0 break-words align-top"
                    >
                      <CellLabel className={CAPTION_CLASS}>
                        {t("linkedPayee")}
                      </CellLabel>
                      {person.payeeId && payee ? (
                        <Link
                          href={`/payees/${person.payeeId}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {payee}
                        </Link>
                      ) : (
                        <span className="text-gray-500 dark:text-gray-400">
                          {t("none")}
                        </span>
                      )}
                    </Td>
                    <Td
                      role="cell"
                      className="col-start-1 col-span-2 row-start-3 min-w-0 align-top"
                    >
                      <CellLabel className={CAPTION_CLASS}>
                        {t("groups")}
                      </CellLabel>
                      {person.groups.length === 0 ? (
                        <span className="text-gray-500 dark:text-gray-400">
                          {t("none")}
                        </span>
                      ) : (
                        <ul className="space-y-1">
                          {person.groups.map((group) => (
                            <li
                              key={group.groupId}
                              className="flex flex-wrap justify-between gap-x-4 gap-y-1"
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
                      )}
                    </Td>
                    <Td
                      role="cell"
                      align="right"
                      className="col-start-2 row-start-1 align-top whitespace-nowrap"
                    >
                      <div className="flex justify-end gap-1">
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
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
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

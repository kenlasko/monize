"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { FormActions } from "@/components/ui/FormActions";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useReportData } from "@/hooks/useReportData";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAuthStore } from "@/store/authStore";
import { preferredCurrency } from "@/lib/default-currency";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedCurrencySelect, SharedError } from "./SharedPrimitives";

export function SharedGroupForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const common = useTranslations("common");
  const preferences = usePreferencesStore((s) => s.preferences);
  const firstName = useAuthStore((s) => s.user?.firstName);
  const [initialName] = useState(() => firstName?.trim().slice(0, 80) ?? "");
  const [initialCurrency] = useState(() =>
    preferredCurrency(preferences?.defaultCurrency),
  );
  const [operationId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [myName, setMyName] = useState(initialName);
  const [currencyCode, setCurrency] = useState(initialCurrency);
  const contacts = useReportData(sharedExpensesApi.people, []);
  const [people, setPeople] = useState<
    { id: string; name: string; personId?: string }[]
  >([{ id: crypto.randomUUID(), name: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [discard, setDiscard] = useState(false);
  const dirty = !!(
    name ||
    myName !== initialName ||
    currencyCode !== initialCurrency ||
    people.some((p) => p.name)
  );
  const close = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sharedExpensesApi.createGroup({
        operationId,
        name: name.trim(),
        myName: myName.trim(),
        currencyCode,
        participants: people
          .filter((p) => p.name.trim())
          .map((p) => ({
            name: p.name.trim(),
            ...(p.personId ? { personId: p.personId } : {}),
          })),
      });
      onCreated(result.id);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        pushHistory
        onBeforeClose={() => {
          if (busy) return false;
          if (dirty) {
            setDiscard(true);
            return false;
          }
        }}
        isOpen
        title={t("newGroup")}
        padding="none"
        className="p-6"
        maxWidth="lg"
        onClose={close}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && myName.trim()) void save();
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <SharedError error={error} />
            <Input
              label={t("groupName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
            <Input
              label={t("myName")}
              value={myName}
              onChange={(e) => setMyName(e.target.value)}
              maxLength={80}
            />
            <SharedCurrencySelect
              value={currencyCode}
              onChange={setCurrency}
              label={t("settlementCurrency")}
              help={t("settlementCurrencyHelp")}
            />
            <fieldset className="space-y-3">
              <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
                {t("participants")}
                <InfoTooltip text={t("soloHelp")} usePortal />
                <InfoTooltip text={t("financialPrivacy")} usePortal />
              </legend>
              <SharedError error={contacts.error} retry={contacts.reload} />
              {!!contacts.data?.length && (
                <Select
                  label={t("addSavedPerson")}
                  value=""
                  disabled={people.length >= 49}
                  options={[
                    { value: "", label: t("choose") },
                    ...contacts.data
                      .filter(
                        (contact) =>
                          !people.some(
                            (person) => person.personId === contact.id,
                          ),
                      )
                      .map((contact) => ({
                        value: contact.id,
                        label: contact.name,
                      })),
                  ]}
                  onChange={(event) => {
                    const contact = contacts.data?.find(
                      (item) => item.id === event.target.value,
                    );
                    if (contact)
                      setPeople([
                        ...people.filter((person) => person.name.trim()),
                        {
                          id: crypto.randomUUID(),
                          name: contact.name,
                          personId: contact.id,
                        },
                      ]);
                  }}
                />
              )}
              {people.map((person) => (
                <div className="flex items-center gap-2" key={person.id}>
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={t("participantName")}
                      value={person.name}
                      maxLength={80}
                      onChange={(e) =>
                        setPeople(
                          people.map((p) =>
                            p.id === person.id
                              ? { ...p, name: e.target.value }
                              : p,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 min-w-11 p-2 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    aria-label={
                      person.name
                        ? `${t("removePerson")}: ${person.name}`
                        : t("removePerson")
                    }
                    onClick={() =>
                      setPeople(people.filter((p) => p.id !== person.id))
                    }
                  >
                    <XMarkIcon aria-hidden="true" className="h-5 w-5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={people.length >= 49}
                onClick={() =>
                  setPeople([...people, { id: crypto.randomUUID(), name: "" }])
                }
              >
                {t("addPerson")}
              </Button>
            </fieldset>
          </fieldset>
          <FormActions
            onCancel={close}
            submitLabel={t("save")}
            isSubmitting={busy}
            submitDisabled={!name.trim() || !myName.trim()}
          />
        </form>
      </Modal>
      <ConfirmDialog
        isOpen={discard}
        title={t("discardTitle")}
        message={common("unsavedChanges.message")}
        confirmLabel={t("discard")}
        cancelLabel={t("keepEditing")}
        onCancel={() => setDiscard(false)}
        onConfirm={onClose}
      />
    </>
  );
}

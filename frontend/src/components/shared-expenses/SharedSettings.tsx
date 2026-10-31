"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useReportData } from "@/hooks/useReportData";
import { sharedCommand, sharedExpensesApi } from "@/lib/shared-expenses";
import type {
  SharedGroupDetail,
  SharedParticipant,
} from "@/types/shared-expense";
import { SharedTemplate } from "./SharedTemplate";
import { SharedError, SharedNotice } from "./SharedPrimitives";

export function SharedSettings({
  group,
  onChanged,
}: {
  group: SharedGroupDetail;
  onChanged: () => void;
}) {
  const t = useTranslations("sharedExpenses");
  const router = useRouter();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [newPerson, setNewPerson] = useState("");
  const [editPerson, setEditPerson] = useState<SharedParticipant | null>(null);
  const [personName, setPersonName] = useState("");
  const [invite, setInvite] = useState<SharedParticipant | null>(null);
  const [role, setRole] = useState<"EDITOR" | "VIEWER">("EDITOR");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const people = useReportData(sharedExpensesApi.people, []);
  const invitations = useReportData(
    () =>
      group.role === "OWNER"
        ? sharedExpensesApi.invitations(group.id)
        : Promise.resolve(null),
    [group.id, group.revision],
  );
  const [personLink, setPersonLink] = useState({
    participantId: "",
    personId: "",
  });
  const owner = group.role === "OWNER";
  const pendingCommand = useRef<{
    key: string;
    value: ReturnType<typeof sharedCommand>;
  } | null>(null);
  const commandFor = (kind: string, values: unknown) => {
    const key = JSON.stringify([group.id, group.revision, kind, values]);
    if (pendingCommand.current?.key !== key)
      pendingCommand.current = { key, value: sharedCommand(group.revision) };
    return pendingCommand.current.value;
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      pendingCommand.current = null;
      setConfirmation(null);
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };
  const makeInvite = async () => {
    if (!invite) return;
    await run(async () => {
      const result = await sharedExpensesApi.invite(group.id, {
        ...commandFor("invite", [invite.id, role, email]),
        participantId: invite.id,
        role,
        email: email || undefined,
      });
      setLink(`${window.location.origin}/shared-expenses/join#${result.token}`);
    });
  };
  return (
    <div className="space-y-5">
      {group.ownershipTransfer && (
        <Card padding="md" className="space-y-3">
          <h2 className="font-semibold">{t("transferOwner")}</h2>
          <p>
            {t(
              group.ownershipTransfer.accepted
                ? "ownershipAccepted"
                : "ownershipWaiting",
              {
                name:
                  group.participants.find(
                    (p) => p.id === group.ownershipTransfer?.participantId,
                  )?.name ?? "",
              },
            )}
          </p>
          {group.myParticipantId === group.ownershipTransfer.participantId &&
            !group.ownershipTransfer.accepted && (
              <Button
                disabled={busy}
                onClick={() => {
                  const command = sharedCommand(group.revision);
                  setConfirmation({
                    title: t("acceptOwnership"),
                    message: t("ownershipResponsibility"),
                    action: () =>
                      sharedExpensesApi.acceptOwnership(
                        group.id,
                        group.ownershipTransfer!.requestId,
                        command,
                      ),
                  });
                }}
              >
                {t("acceptOwnership")}
              </Button>
            )}
          {group.role === "OWNER" && group.ownershipTransfer.accepted && (
            <Button
              disabled={busy}
              onClick={() => {
                const command = sharedCommand(group.revision);
                setConfirmation({
                  title: t("completeOwnership"),
                  message: t("ownershipResponsibility"),
                  action: () =>
                    sharedExpensesApi.membership(
                      group.id,
                      group.ownershipTransfer!.participantId,
                      "TRANSFER_OWNER",
                      command,
                    ),
                });
              }}
            >
              {t("completeOwnership")}
            </Button>
          )}
        </Card>
      )}

      <SharedError error={error} />
      {owner && (
        <Card padding="md">
          <div className="max-w-lg space-y-4">
            <Input
              label={t("groupName")}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label={t("description")}
              value={description}
              maxLength={750}
              onChange={(e) => setDescription(e.target.value)}
            />
            <Button
              disabled={busy || !!group.archivedAt || !name.trim()}
              onClick={() =>
                run(() =>
                  sharedExpensesApi.updateGroup(group.id, {
                    ...commandFor("group", [name, description]),
                    name,
                    description,
                  }),
                )
              }
            >
              {t("save")}
            </Button>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t("groupCurrencyLocked")}
            </p>
          </div>
        </Card>
      )}
      {owner && (
        <SharedTemplate
          key={group.revision}
          group={group}
          onChanged={onChanged}
        />
      )}
      <Card padding="md">
        <h2 className="text-lg font-semibold mb-4">{t("participants")}</h2>
        <ul className="space-y-3">
          {group.participants.map((person) => (
            <li
              className="flex flex-wrap justify-between items-center gap-3 border-b border-gray-100 dark:border-gray-700 pb-3"
              key={person.id}
            >
              <div className="min-w-0">
                <p className="font-medium break-words">{person.name}</p>
                <Badge>
                  {person.connected
                    ? t(person.role ?? "EDITOR")
                    : t("offlinePerson")}
                </Badge>
              </div>
              {owner && !group.archivedAt && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditPerson(person);
                      setPersonName(person.name);
                    }}
                  >
                    {t("edit")}
                  </Button>
                  {!person.connected && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        const command = sharedCommand(group.revision);
                        setConfirmation({
                          title: t(
                            person.isActive
                              ? "deactivatePerson"
                              : "reactivatePerson",
                          ),
                          message: t("deactivatePersonHelp"),
                          action: () =>
                            sharedExpensesApi.participant(group.id, person.id, {
                              ...command,
                              name: person.name,
                              isActive: !person.isActive,
                            }),
                        });
                      }}
                    >
                      {t(
                        person.isActive
                          ? "deactivatePerson"
                          : "reactivatePerson",
                      )}
                    </Button>
                  )}
                  {!person.connected ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setInvite(person);
                        setLink("");
                        setEmail("");
                        setCopied(false);
                      }}
                    >
                      {t("invite")}
                    </Button>
                  ) : (
                    person.role !== "OWNER" && (
                      <Select
                        aria-label={`${t("role")} ${person.name}`}
                        value={person.role ?? ""}
                        options={[
                          { value: "EDITOR", label: t("EDITOR") },
                          { value: "VIEWER", label: t("VIEWER") },
                          { value: "REVOKE", label: t("revoke") },
                          {
                            value: "REQUEST_OWNER",
                            label: t("requestOwner"),
                          },
                        ]}
                        onChange={(e) => {
                          const action = e.target.value as
                            | "EDITOR"
                            | "VIEWER"
                            | "REVOKE"
                            | "REQUEST_OWNER"
                            | "TRANSFER_OWNER";
                          const command = sharedCommand(group.revision);
                          setConfirmation({
                            title: t("confirmRole"),
                            message: t("accessHelp"),
                            action: () =>
                              sharedExpensesApi.membership(
                                group.id,
                                person.id,
                                action,
                                command,
                              ),
                          });
                        }}
                      />
                    )
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {owner && !group.archivedAt && (
          <div className="mt-5 flex flex-wrap gap-3 items-end">
            <div className="w-full sm:w-72">
              <Input
                label={t("participantName")}
                value={newPerson}
                maxLength={80}
                onChange={(e) => setNewPerson(e.target.value)}
              />
            </div>
            <Button
              disabled={busy || !newPerson.trim()}
              onClick={() =>
                run(async () => {
                  await sharedExpensesApi.participant(group.id, undefined, {
                    ...commandFor("new-person", newPerson),
                    name: newPerson,
                  });
                  setNewPerson("");
                })
              }
            >
              {t("addPerson")}
            </Button>
          </div>
        )}
      </Card>
      <Card padding="md">
        <h2 className="text-lg font-semibold mb-3">{t("personLink")}</h2>
        <SharedNotice>{t("personHelp")}</SharedNotice>
        <SharedError error={people.error} retry={people.reload} />
        <div className="grid gap-3 mt-4 sm:grid-cols-2">
          <Select
            label={t("participants")}
            value={personLink.participantId}
            options={[
              { value: "", label: t("choose") },
              ...group.participants.map((p) => ({
                value: p.id,
                label: p.name,
              })),
            ]}
            onChange={(e) =>
              setPersonLink({ ...personLink, participantId: e.target.value })
            }
          />
          <Select
            label={t("people")}
            value={personLink.personId}
            options={[
              { value: "", label: t("choose") },
              ...(people.data ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              })),
            ]}
            onChange={(e) =>
              setPersonLink({ ...personLink, personId: e.target.value })
            }
          />
        </div>
        <Button
          className="mt-3"
          disabled={busy || !personLink.participantId || !personLink.personId}
          onClick={() =>
            run(() =>
              sharedExpensesApi.linkPerson(
                group.id,
                personLink.personId,
                personLink.participantId,
              ),
            )
          }
        >
          {t("link")}
        </Button>
      </Card>
      {owner && (
        <Card padding="md">
          <h2 className="font-semibold mb-3">{t("invite")}</h2>
          <SharedError error={invitations.error} retry={invitations.reload} />
          <ul className="space-y-2">
            {invitations.data
              ?.filter((i) => !i.revokedAt && !i.consumedAt)
              .map((i) => (
                <li key={i.id} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {
                      group.participants.find((p) => p.id === i.participantId)
                        ?.name
                    }
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        sharedExpensesApi.revokeInvitation(
                          group.id,
                          i.id,
                          commandFor("revoke-invite", i.id),
                        ),
                      )
                    }
                  >
                    {t("revoke")}
                  </Button>
                </li>
              ))}
          </ul>
        </Card>
      )}
      <Card padding="md">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => sharedExpensesApi.mute(group.id, !group.muted))
            }
          >
            {t(group.muted ? "unmute" : "mute")}
          </Button>
          {owner ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const command = sharedCommand(group.revision);
                setConfirmation({
                  title: t(group.archivedAt ? "unarchive" : "archive"),
                  message: t("archiveHelp"),
                  action: () =>
                    sharedExpensesApi.updateGroup(group.id, {
                      ...command,
                      archived: !group.archivedAt,
                    }),
                });
              }}
            >
              {t(group.archivedAt ? "unarchive" : "archive")}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                setConfirmation({
                  title: t("leave"),
                  message: t("leaveHelp"),
                  action: async () => {
                    await sharedExpensesApi.leave(group.id);
                    router.push("/shared-expenses");
                  },
                })
              }
            >
              {t("leave")}
            </Button>
          )}
        </div>
      </Card>
      {owner && group.entryCount === 0 && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const command = sharedCommand(group.revision);
            setConfirmation({
              title: t("deleteGroup"),
              message: t("deleteGroupHelp"),
              action: async () => {
                await sharedExpensesApi.deleteEmptyGroup(group.id, command);
                router.push("/shared-expenses");
              },
            });
          }}
        >
          {t("deleteGroup")}
        </Button>
      )}
      {editPerson && (
        <Modal
          isOpen
          title={t("edit")}
          padding="md"
          onClose={busy ? undefined : () => setEditPerson(null)}
          footer={
            <Button
              disabled={busy || !personName.trim()}
              onClick={() =>
                run(async () => {
                  await sharedExpensesApi.participant(group.id, editPerson.id, {
                    ...commandFor("person", [editPerson.id, personName]),
                    name: personName,
                  });
                  setEditPerson(null);
                })
              }
            >
              {t("save")}
            </Button>
          }
        >
          <SharedError error={error} />
          <Input
            label={t("participantName")}
            value={personName}
            maxLength={80}
            onChange={(e) => setPersonName(e.target.value)}
          />
        </Modal>
      )}
      {invite && (
        <Modal
          isOpen
          title={t("invite")}
          description={invite.name}
          padding="md"
          onClose={busy ? undefined : () => setInvite(null)}
          footer={
            <Button disabled={busy} onClick={() => setInvite(null)}>
              {t("close")}
            </Button>
          }
        >
          <div className="space-y-4">
            <SharedError error={error} />
            <SharedNotice>{t("inviteHelp")}</SharedNotice>
            {link ? (
              <>
                <Input label={t("inviteLink")} value={link} readOnly />
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                    } catch (cause) {
                      setError(cause);
                    }
                  }}
                >
                  {t(copied ? "linkCopied" : "copyLink")}
                </Button>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("inviteExpiry")}
                </p>
              </>
            ) : (
              <>
                <Select
                  label={t("role")}
                  value={role}
                  options={(["EDITOR", "VIEWER"] as const).map((value) => ({
                    value,
                    label: t(value),
                  }))}
                  onChange={(e) =>
                    setRole(e.target.value as "EDITOR" | "VIEWER")
                  }
                />
                <Input
                  label={t("inviteEmail")}
                  type="email"
                  value={email}
                  maxLength={254}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button isLoading={busy} onClick={makeInvite}>
                  {t("makeInvitation")}
                </Button>
              </>
            )}
          </div>
        </Modal>
      )}
      <ConfirmDialog
        isOpen={!!confirmation}
        title={confirmation?.title ?? ""}
        message={confirmation?.message ?? ""}
        onConfirm={() => {
          if (confirmation && !busy) void run(confirmation.action);
        }}
        onCancel={() => {
          if (!busy) setConfirmation(null);
        }}
      />
    </div>
  );
}

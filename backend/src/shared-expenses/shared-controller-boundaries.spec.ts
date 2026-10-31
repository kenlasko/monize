import { AuthGuard } from "@nestjs/passport";
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { SharedExpensesController } from "./shared-expenses.controller";
import { SharedFinanceController } from "./shared-finance.controller";
import { SharedEntryFinanceController } from "./shared-entry-finance.controller";
import { SharedDocumentsController } from "./shared-documents.controller";
import { SharedReviewController } from "./shared-review.controller";
import { SharedGroupsService } from "./shared-groups.service";
import { SharedEntriesService } from "./shared-entries.service";
import { SharedInvitationsService } from "./shared-invitations.service";
import { SharedMembershipsService } from "./shared-memberships.service";
import { SharedPeopleService } from "./shared-people.service";
import { SharedCollaborationService } from "./shared-collaboration.service";
import { SharedFinanceService } from "./shared-finance.service";
import type { SharedEntryDto } from "./dto/shared-entry.dto";

const USER = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const command = { operationId: ITEM, expectedRevision: 4 };
const request = { user: { id: USER } };
const mocks = (...names: string[]): Record<string, jest.Mock> =>
  Object.fromEntries(
    names.map((name) => [name, jest.fn().mockResolvedValue({ id: ITEM })]),
  );

describe("Shared controller identity and command boundary", () => {
  const controllers = [
    SharedExpensesController,
    SharedFinanceController,
    SharedEntryFinanceController,
    SharedDocumentsController,
    SharedReviewController,
  ];
  it.each(controllers)(
    "requires JWT and UUID parameter pipes on %p",
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(
        AuthGuard("jwt"),
      );
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === "constructor") continue;
        const args = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          controller,
          name,
        ) as Record<string, { data?: string; pipes: unknown[] }> | undefined;
        for (const [key, argument] of Object.entries(args ?? {})) {
          // Nest RouteParamtypes.PARAM = 5. Every route id uses the same boundary.
          if (key.startsWith("5:"))
            expect(argument.pipes).toContain(ParseUUIDPipe);
        }
      }
    },
  );
  it("carries the authenticated identity and caller's revision through every group route", async () => {
    const collaboration = mocks("activity", "remind");
    const groups = mocks(
      "overview",
      "list",
      "create",
      "detail",
      "export",
      "update",
      "participant",
      "removeEmpty",
    );
    const finance = mocks("privateGroups", "postingLocation");
    const entries = mocks("get", "preview", "save", "reverse");
    const invitations = mocks("list", "create", "revoke", "inspect", "claim");
    const memberships = mocks("change", "acceptOwnership", "mute", "leave");
    const people = mocks("list", "save", "remove", "link");
    const controller = new SharedExpensesController(
      collaboration as unknown as SharedCollaborationService,
      groups as unknown as SharedGroupsService,
      finance as unknown as SharedFinanceService,
      entries as unknown as SharedEntriesService,
      invitations as unknown as SharedInvitationsService,
      memberships as unknown as SharedMembershipsService,
      people as unknown as SharedPeopleService,
    );
    const groupDto = {
      operationId: ITEM,
      name: "Trip",
      myName: "Me",
      currencyCode: "PLN",
      participants: [],
    };
    const participant = { ...command, name: "Anna" };
    const entry: SharedEntryDto = {
      ...command,
      type: "EXPENSE",
      title: "Dinner",
      amount: "300",
      currencyCode: "PLN",
      date: "2026-01-01",
      splitMode: "EQUAL",
      shares: [{ participantId: ITEM }],
      contributions: [{ participantId: ITEM, value: "300" }],
    };
    const query = { offset: 100, search: "Dinner" };
    const invite = { ...command, participantId: ITEM, role: "VIEWER" as const };
    const reverse = { ...command, reason: "Duplicate" };
    const role = { ...command, action: "REVOKE" as const };
    const contact = { name: "Anna", payeeId: ITEM };
    const link = { participantId: ITEM, personId: ITEM };
    const cases: [() => unknown, jest.Mock, unknown[]][] = [
      [() => controller.overview(request), groups.overview, [USER]],
      [
        () => controller.privateFinances(request),
        finance.privateGroups,
        [USER],
      ],
      [
        () => controller.postingLocation(request, ITEM),
        finance.postingLocation,
        [USER, ITEM],
      ],
      [
        () => controller.removeEmpty(request, GROUP, command),
        groups.removeEmpty,
        [USER, GROUP, command],
      ],
      [
        () => controller.activity(request, GROUP, query),
        collaboration.activity,
        [USER, GROUP, 100],
      ],
      [
        () => controller.remind(request, GROUP, ITEM, command),
        collaboration.remind,
        [USER, GROUP, ITEM, command],
      ],
      [() => controller.list(request), groups.list, [USER]],
      [
        () => controller.create(request, groupDto),
        groups.create,
        [USER, groupDto],
      ],
      [
        () => controller.detail(request, GROUP, query),
        groups.detail,
        [USER, GROUP, 100, query],
      ],
      [() => controller.export(request, GROUP), groups.export, [USER, GROUP]],
      [
        () => controller.update(request, GROUP, command),
        groups.update,
        [USER, GROUP, command],
      ],
      [
        () => controller.addParticipant(request, GROUP, participant),
        groups.participant,
        [USER, GROUP, undefined, participant],
      ],
      [
        () => controller.updateParticipant(request, GROUP, ITEM, participant),
        groups.participant,
        [USER, GROUP, ITEM, participant],
      ],
      [
        () => controller.entry(request, GROUP, ITEM),
        entries.get,
        [USER, GROUP, ITEM],
      ],
      [
        () => controller.preview(request, GROUP, entry),
        entries.preview,
        [USER, GROUP, entry],
      ],
      [
        () => controller.previewEdit(request, GROUP, ITEM, entry),
        entries.preview,
        [USER, GROUP, entry, ITEM],
      ],
      [
        () => controller.createEntry(request, GROUP, entry),
        entries.save,
        [USER, GROUP, entry],
      ],
      [
        () => controller.updateEntry(request, GROUP, ITEM, entry),
        entries.save,
        [USER, GROUP, entry, ITEM],
      ],
      [
        () => controller.reverseEntry(request, GROUP, ITEM, reverse),
        entries.reverse,
        [USER, GROUP, ITEM, reverse],
      ],
      [
        () => controller.listInvitations(request, GROUP),
        invitations.list,
        [USER, GROUP],
      ],
      [
        () => controller.invite(request, GROUP, invite),
        invitations.create,
        [USER, GROUP, invite],
      ],
      [
        () => controller.revokeInvitation(request, GROUP, ITEM, command),
        invitations.revoke,
        [USER, GROUP, ITEM, command],
      ],
      [
        () => controller.inspect(request, { token: "secret" }),
        invitations.inspect,
        [USER, "secret"],
      ],
      [
        () => controller.claim(request, { token: "secret" }),
        invitations.claim,
        [USER, "secret"],
      ],
      [
        () => controller.membership(request, GROUP, ITEM, role),
        memberships.change,
        [USER, GROUP, ITEM, role],
      ],
      [
        () => controller.acceptOwnership(request, GROUP, ITEM, command),
        memberships.acceptOwnership,
        [USER, GROUP, ITEM, command],
      ],
      [
        () => controller.mute(request, GROUP, { muted: true }),
        memberships.mute,
        [USER, GROUP, true],
      ],
      [
        () => controller.leave(request, GROUP),
        memberships.leave,
        [USER, GROUP],
      ],
      [() => controller.listPeople(request), people.list, [USER]],
      [
        () => controller.createPerson(request, contact),
        people.save,
        [USER, contact],
      ],
      [
        () => controller.updatePerson(request, ITEM, contact),
        people.save,
        [USER, contact, ITEM],
      ],
      [
        () => controller.deletePerson(request, ITEM),
        people.remove,
        [USER, ITEM],
      ],
      [
        () => controller.linkPerson(request, GROUP, link),
        people.link,
        [USER, GROUP, link],
      ],
    ];
    for (const [invoke, target, args] of cases) {
      target.mockClear();
      expect(await invoke()).toEqual({ id: ITEM });
      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(...args);
    }
  });
});

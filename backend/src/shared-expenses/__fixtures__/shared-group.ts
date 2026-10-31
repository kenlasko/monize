import type { SharedGroup, SharedParticipant } from "../shared-types";

export const sharedGroupFixture = (
  patch: Partial<SharedGroup> = {},
): SharedGroup => ({
  id: "group",
  ownerUserId: "owner",
  name: "Trip",
  description: null,
  currencyCode: "PLN",
  decimalPlaces: 2,
  revision: 4,
  financialRevision: 2,
  archivedAt: null,
  role: "OWNER",
  myParticipantId: "me",
  ...patch,
});
export const sharedPeopleFixture = (): SharedParticipant[] => [
  { id: "me", name: "Me", isActive: true, connected: true, role: "OWNER" },
  { id: "anna", name: "Anna", isActive: true, connected: true, role: "EDITOR" },
];

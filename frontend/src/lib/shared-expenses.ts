import apiClient from "./api";
import { getErrorMessage } from "./errors";
import { invalidateBalanceCaches } from "./apiCache";
import type {
  SharedCommand,
  SharedReviewSummary,
  SharedEntryFinanceInput,
  SharedEntry,
  SharedEntryInput,
  SharedFinanceInput,
  SharedFinanceOverview,
  SharedFinancePreview,
  SharedGroup,
  SharedGroupDetail,
  SharedPerson,
} from "@/types/shared-expense";

const root = "/shared-expenses";
const groupPath = (id: string) => `${root}/groups/${id}`;
export const sharedCommand = (expectedRevision = 0): SharedCommand => ({
  operationId: crypto.randomUUID(),
  expectedRevision,
});

export const sharedExpensesApi = {
  review: async () => (await apiClient.get<SharedReviewSummary>(`${root}/private-finances/review`)).data,
  overview: async () =>
    (
      await apiClient.get<{
        groups: SharedGroup[];
        totals: {
          currencyCode: string;
          receivable: string | null;
          payable: string | null;
          unresolvedGroupIds: string[];
        }[];
      }>(`${root}/overview`)
    ).data,
  previewEntryFinance: async (id: string, input: SharedEntryFinanceInput) =>
    (
      await apiClient.post<{
        entry: SharedEntry;
        finance: SharedFinancePreview;
        fingerprint: string;
      }>(`${groupPath(id)}/entry-finances/preview`, input)
    ).data,
  saveEntryFinance: async (id: string, input: SharedEntryFinanceInput) => {
    const result = (
      await apiClient.post<{ entry: SharedEntry; postingId: string }>(
        `${groupPath(id)}/entry-finances`,
        input,
      )
    ).data;
    invalidateBalanceCaches();
    return result;
  },
  postingLocation: async (id: string) =>
    (
      await apiClient.get<{ groupId: string; entryId: string }>(
        `${root}/private-finances/postings/${id}`,
      )
    ).data,
  activity: async (id: string, offset: number) =>
    (
      await apiClient.get<{
        items: SharedGroupDetail["activity"];
        nextOffset: number | null;
      }>(`${groupPath(id)}/activity`, { params: { offset } })
    ).data,
  remind: async (id: string, participantId: string, command: SharedCommand) =>
    apiClient.post(
      `${groupPath(id)}/participants/${participantId}/remind`,
      command,
    ),
  privateGroups: async () =>
    (
      await apiClient.get<
        {
          groupId: string;
          accountId: string;
          name: string;
          currencyCode: string;
        }[]
      >(`${root}/private-finances`)
    ).data,
  groups: async () =>
    (await apiClient.get<SharedGroup[]>(`${root}/groups`)).data,
  group: async (
    id: string,
    offset = 0,
    filters: {
      search?: string;
      type?: string;
      participantId?: string;
      startDate?: string;
      endDate?: string;
    } = {},
  ) =>
    (
      await apiClient.get<SharedGroupDetail>(groupPath(id), {
        params: { offset, ...filters },
      })
    ).data,
  export: async (id: string) =>
    (
      await apiClient.get<{
        group: SharedGroup;
        participants: SharedGroupDetail["participants"];
        entries: SharedEntry[];
        balances: SharedGroupDetail["balances"];
      }>(`${groupPath(id)}/export`)
    ).data,
  createGroup: async (input: {
    operationId: string;
    name: string;
    myName: string;
    currencyCode: string;
    description?: string;
    participants: { name: string; personId?: string }[];
  }) => (await apiClient.post<{ id: string }>(`${root}/groups`, input)).data,
  deleteEmptyGroup: async (id: string, command: SharedCommand) =>
    apiClient.delete(groupPath(id), { data: command }),
  updateGroup: async (
    id: string,
    input: SharedCommand & {
      name?: string;
      description?: string;
      archived?: boolean;
      currencyCode?: string;
      splitTemplate?: SharedGroup["splitTemplate"];
    },
  ) => (await apiClient.patch(groupPath(id), input)).data,
  participant: async (
    id: string,
    participantId: string | undefined,
    input: SharedCommand & {
      name: string;
      isActive?: boolean;
      personId?: string;
    },
  ) =>
    (
      await apiClient.request({
        method: participantId ? "PATCH" : "POST",
        url: `${groupPath(id)}/participants${participantId ? `/${participantId}` : ""}`,
        data: input,
      })
    ).data,
  entry: async (id: string, entryId: string) =>
    (await apiClient.get<SharedEntry>(`${groupPath(id)}/entries/${entryId}`))
      .data,
  preview: async (id: string, input: SharedEntryInput, entryId?: string) =>
    (
      await apiClient.post<SharedEntry>(
        `${groupPath(id)}/entries${entryId ? `/${entryId}` : ""}/preview`,
        input,
      )
    ).data,
  saveEntry: async (id: string, input: SharedEntryInput, entryId?: string) =>
    (
      await apiClient.request<SharedEntry>({
        method: entryId ? "PATCH" : "POST",
        url: `${groupPath(id)}/entries${entryId ? `/${entryId}` : ""}`,
        data: input,
      })
    ).data,
  reverse: async (
    id: string,
    entry: SharedEntry,
    reason: string,
    command: SharedCommand,
  ) =>
    (
      await apiClient.post(`${groupPath(id)}/entries/${entry.id}/reverse`, {
        ...command,
        reason,
      })
    ).data,
  invite: async (
    id: string,
    input: SharedCommand & {
      participantId: string;
      role: "EDITOR" | "VIEWER";
      email?: string;
    },
  ) =>
    (
      await apiClient.post<{ id: string; token: string; revision: number }>(
        `${groupPath(id)}/invitations`,
        input,
      )
    ).data,
  invitations: async (id: string) =>
    (
      await apiClient.get<
        {
          id: string;
          participantId: string;
          role: string;
          expiresAt: string;
          revokedAt: string | null;
          consumedAt: string | null;
        }[]
      >(`${groupPath(id)}/invitations`)
    ).data,
  revokeInvitation: async (
    id: string,
    invitationId: string,
    command: SharedCommand,
  ) =>
    apiClient.post(
      `${groupPath(id)}/invitations/${invitationId}/revoke`,
      command,
    ),
  inspect: async (token: string) =>
    (
      await apiClient
        .post<{
          groupName: string;
          participantName: string;
          role: string;
          alreadyJoined: boolean;
        }>(`${root}/invitations/inspect`, { token })
        .catch(safeInvitationError)
    ).data,
  claim: async (token: string) =>
    (
      await apiClient
        .post<{ id: string }>(`${root}/invitations/claim`, {
          token,
        })
        .catch(safeInvitationError)
    ).data,
  acceptOwnership: async (
    id: string,
    requestId: string,
    command: SharedCommand,
  ) =>
    apiClient.post(`${groupPath(id)}/ownership/${requestId}/accept`, command),
  membership: async (
    id: string,
    participantId: string,
    action: "EDITOR" | "VIEWER" | "REVOKE" | "REQUEST_OWNER" | "TRANSFER_OWNER",
    command: SharedCommand,
  ) =>
    apiClient.patch(`${groupPath(id)}/memberships/${participantId}`, {
      ...command,
      action,
    }),
  mute: async (id: string, muted: boolean) =>
    apiClient.patch(`${groupPath(id)}/mute`, { muted }),
  leave: async (id: string) => apiClient.post(`${groupPath(id)}/leave`),
  people: async () =>
    (await apiClient.get<SharedPerson[]>(`${root}/people`)).data,
  savePerson: async (input: { name: string; payeeId?: string }, id?: string) =>
    (
      await apiClient.request<{ id: string }>({
        method: id ? "PATCH" : "POST",
        url: `${root}/people${id ? `/${id}` : ""}`,
        data: input,
      })
    ).data,
  linkPerson: async (id: string, personId: string, participantId: string) =>
    apiClient.post(`${groupPath(id)}/people`, { personId, participantId }),
  deletePerson: async (id: string) => apiClient.delete(`${root}/people/${id}`),
  finances: async (id: string) =>
    (await apiClient.get<SharedFinanceOverview>(`${groupPath(id)}/finances`))
      .data,
  enableFinance: async (
    id: string,
    input: SharedCommand & { accountName: string },
  ) => {
    const result = await apiClient.post(
      `${groupPath(id)}/finances/enable`,
      input,
    );
    invalidateBalanceCaches();
    return result.data;
  },
  previewFinance: async (
    id: string,
    entryId: string,
    input: SharedFinanceInput,
  ) =>
    (
      await apiClient.post<SharedFinancePreview>(
        `${groupPath(id)}/finances/entries/${entryId}/preview`,
        input,
      )
    ).data,
  book: async (id: string, entryId: string, input: SharedFinanceInput) => {
    const result = await apiClient.post(
      `${groupPath(id)}/finances/entries/${entryId}/book`,
      input,
    );
    invalidateBalanceCaches();
    return result.data;
  },
  unlink: async (id: string, entryId: string, command: SharedCommand) => {
    await apiClient.post(
      `${groupPath(id)}/finances/entries/${entryId}/unlink`,
      command,
    );
    invalidateBalanceCaches();
  },
};

/** Do not let an Axios request config carry an invitation token into diagnostics. */
function safeInvitationError(cause: unknown): never {
  throw new Error(getErrorMessage(cause, ""));
}

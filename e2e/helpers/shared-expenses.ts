import { randomUUID } from "node:crypto";
import type { ApiClient } from "./api";

export interface SharedGroupFixture {
  id: string;
  revision: number;
  financialRevision: number;
  myParticipantId: string;
  participants: { id: string; name: string }[];
  entries: { id: string; title: string }[];
  balances: {
    totalExpenses: string | null;
    positions: { participantId: string; balance: string | null }[];
  };
}

export async function createSharedGroup(
  api: ApiClient,
  name = "Mountain weekend",
  currencyCode = "USD",
): Promise<SharedGroupFixture> {
  const result = await api.post<{ id: string }>("/shared-expenses/groups", {
    operationId: randomUUID(),
    name,
    myName: "Robert",
    currencyCode,
    participants: [{ name: "Anna" }, { name: "Bartek" }],
  });
  return api.get<SharedGroupFixture>(`/shared-expenses/groups/${result.id}`);
}

export async function createSharedExpense(
  api: ApiClient,
  group: SharedGroupFixture,
  title = "Weekend groceries",
) {
  return api.post<{ id: string }>(
    `/shared-expenses/groups/${group.id}/entries`,
    {
      operationId: randomUUID(),
      expectedRevision: 0,
      type: "EXPENSE",
      title,
      amount: "300",
      currencyCode: "USD",
      date: new Date().toISOString().slice(0, 10),
      splitMode: "EQUAL",
      shares: group.participants.map((person) => ({
        participantId: person.id,
      })),
      contributions: [{ participantId: group.myParticipantId, value: "300" }],
    },
  );
}

/** A split bank fact, with distinguishable residual categories and notes. */
export function createSharedSplitSource(
  api: ApiClient,
  accountId: string,
  mealCategoryId: string,
  supplyCategoryId: string,
) {
  return api.post<{
    id: string;
    splits: { id: string; amount: number; memo: string; categoryId: string }[];
  }>("/transactions", {
    accountId,
    amount: -350,
    currencyCode: "USD",
    transactionDate: new Date().toISOString().slice(0, 10),
    payeeName: "Split market",
    isSplit: true,
    splits: [
      { categoryId: mealCategoryId, amount: -200, memo: "Meal purchases" },
      { categoryId: supplyCategoryId, amount: -150, memo: "Supplies" },
    ],
  });
}

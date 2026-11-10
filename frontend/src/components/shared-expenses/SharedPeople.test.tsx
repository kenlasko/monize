import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test/render";
import { SharedPeople } from "./SharedPeople";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { payeesApi } from "@/lib/payees";
import { useMobileAddActionStore } from "@/store/mobileAddActionStore";
import type { SharedPerson, SharedPosition } from "@/types/shared-expense";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: {
    people: vi.fn(),
    savePerson: vi.fn(),
    deletePerson: vi.fn(),
  },
}));
vi.mock("@/lib/payees", async (original) => ({
  ...(await original<typeof import("@/lib/payees")>()),
  payeesApi: { getAll: vi.fn() },
}));

const position = (balance: string | null) =>
  ({ participantId: "p", balance, knownBalance: balance ?? "0" }) as SharedPosition;

const people: SharedPerson[] = [
  {
    id: "anna",
    name: "Anna",
    payeeId: "payee-anna",
    groups: [
      {
        groupId: "trip",
        groupName: "Ski trip",
        currencyCode: "CAD",
        participantId: "p",
        position: position("25.0000"),
      },
    ],
  },
  { id: "ben", name: "Ben", payeeId: null, groups: [] },
];

async function renderPeople(props: { linkedPayeeId?: string } = {}) {
  await act(async () => {
    render(<SharedPeople {...props} />);
  });
}

describe("SharedPeople", () => {
  beforeEach(() => {
    vi.mocked(sharedExpensesApi.people).mockResolvedValue(people);
    vi.mocked(payeesApi.getAll).mockResolvedValue([
      { id: "payee-anna", name: "Anna Smith" },
    ] as Awaited<ReturnType<typeof payeesApi.getAll>>);
    useMobileAddActionStore.setState({ action: null });
  });

  it("lists contacts in a table with the linked payee and each group", async () => {
    await renderPeople();
    const table = screen.getByRole("table", { name: "People" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers.slice(0, 3)).toEqual(["Name", "Linked Payee", "Groups"]);
    const [, anna, ben] = within(table).getAllByRole("row");
    expect(
      within(anna).getByRole("link", { name: "Anna Smith" }),
    ).toHaveAttribute("href", "/payees/payee-anna");
    expect(
      within(anna).getByRole("link", { name: "Ski trip" }),
    ).toHaveAttribute("href", "/shared-expenses/trip");
    // No payee and no groups read as "None", not as a blank cell.
    expect(within(ben).getAllByText("None")).toHaveLength(2);
    expect(within(ben).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("shows only the contacts of a linked payee's page", async () => {
    await renderPeople({ linkedPayeeId: "payee-anna" });
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("Anna")).toBeInTheDocument();
  });

  it("makes the mobile add button start a new contact", async () => {
    await renderPeople();
    const action = useMobileAddActionStore.getState().action;
    expect(action?.label).toBe("New Person");
    await act(async () => action?.run());
    expect(
      screen.getByRole("dialog", { name: "Save Person" }),
    ).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedPrivateFinances } from "./SharedPrivateFinances";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: {
    finances: vi.fn(),
    privateGroups: vi.fn(),
    unlink: vi.fn(),
  },
}));

describe("SharedPrivateFinances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sharedExpensesApi.finances).mockResolvedValue({
      integration: null,
      entries: [],
      pendingCount: 0,
    });
  });

  // The group id reaches the link from the <select> value, so it is DOM text
  // (CodeQL js/xss-through-dom); it must be encoded as one path segment.
  it("encodes the selected group id into the group link", async () => {
    const groupId = "../javascript:alert(1)?x=<b>";
    vi.mocked(sharedExpensesApi.privateGroups).mockResolvedValue([
      { groupId, accountId: "account", name: "Weekend", currencyCode: "PLN" },
    ]);
    await act(async () => render(<SharedPrivateFinances />));
    expect(screen.getByRole("link", { name: "Open Group" })).toHaveAttribute(
      "href",
      `/shared-expenses/${encodeURIComponent(groupId)}`,
    );
  });
});

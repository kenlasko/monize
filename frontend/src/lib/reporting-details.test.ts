import { describe, expect, it } from "vitest";
import { reportingDetailsFromUrl } from "./reporting-details";
const id = "11111111-1111-4111-8111-111111111111";
describe("recognition drilldown selection", () => {
  it("preserves effective dates and all supported dimensions", () => {
    expect(
      reportingDetailsFromUrl(
        `/transactions?startDate=2026-01-01&endDate=2026-01-31&categoryIds=${id}&accountId=${id}&payeeIds=${id}&tagId=${id}&accountStatus=all`,
      ),
    ).toEqual({
      basis: "accrual",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      categoryIds: [id],
      accountIds: [id],
      payeeIds: [id],
      tagIds: [id],
      limit: 2000,
    });
  });
  it.each(["uncategorized", "income", "expense", "transfer"])(
    "supports pseudo category %s",
    (category) => {
      const result = reportingDetailsFromUrl(
        `/transactions?categoryId=${category}`,
      );
      expect(result).toMatchObject(
        category === "uncategorized"
          ? { uncategorized: true }
          : category === "transfer"
            ? { kind: "transfer" }
            : { categoryType: category },
      );
    },
  );
  it.each([
    "searchText=tax",
    "accountStatus=active",
    "unsupported=true",
    "categoryIds=uncategorized,invalid",
    "categoryId=income&categoryType=expense",
    "startDate=2026-01-01&startDate=2026-02-01",
  ])("refuses an unrepresentable selection: %s", (query) => {
    expect(() => reportingDetailsFromUrl(`/transactions?${query}`)).toThrow(
      "unsupported",
    );
  });
  it("leaves other navigation alone", () =>
    expect(reportingDetailsFromUrl("/reports")).toBeNull());
});

it("serializes recognition selections as repeated bare query keys", async () => {
  const { vi } = await import("vitest");
  const { default: apiClient } = await import("./api");
  const { reportingDetailsApi } = await import("./reporting-details");
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: {} });
  try {
    await reportingDetailsApi.get({
      basis: "accrual",
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      categoryIds: [id, id],
      accountIds: [id],
    });
    const [url, config] = get.mock.calls[0];
    const uri = apiClient.getUri({ url, ...config });
    const query = new URL(uri, "https://internal.invalid").searchParams;
    expect(query.getAll("categoryIds")).toEqual([id, id]);
    expect(query.getAll("accountIds")).toEqual([id]);
    expect([...query.keys()].some((key) => key.includes("["))).toBe(false);
  } finally {
    get.mockRestore();
  }
});

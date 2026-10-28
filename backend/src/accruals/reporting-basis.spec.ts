import type { DataSource, EntityManager } from "typeorm";
import {
  currentReportingRead,
  resolveReportingBasis,
  resolveReportingExecution,
  withReportingRead,
  reportingExecutionBasis,
} from "./reporting-basis";
jest.mock("../common/db/scoped-db", () => ({
  withScopedDb: async (
    source: { manager: EntityManager },
    fn: (m: EntityManager) => unknown,
  ) => fn(source.manager),
}));
function fixture(
  enabled: boolean,
  present = false,
  preferred?: "cash" | "accrual",
) {
  const preference = { accrualEnabled: enabled, reportingBasis: preferred };
  const query = jest.fn().mockResolvedValue([{ present }]);
  const manager = {
    getRepository: () => ({ findOne: async () => preference }),
    query,
  } as unknown as EntityManager;
  return { manager, query, source: { manager } as DataSource };
}
describe("selected basis and physical execution", () => {
  it("forces cash while disabled, including an explicit or remembered accrual selection", async () => {
    const f = fixture(false, true, "accrual");
    expect(await resolveReportingBasis(f.manager, "owner", "accrual")).toBe(
      "cash",
    );
    await withReportingRead(
      f.source,
      "owner",
      async () => {
        expect(currentReportingRead("owner")?.basis).toBe("cash");
        expect(
          await resolveReportingExecution(f.manager, "owner", "accrual"),
        ).toBe("cash");
      },
      "accrual",
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it("uses cash as the fallback default for an enabled user", async () => {
    const f = fixture(true);
    expect(await resolveReportingBasis(f.manager, "owner")).toBe("cash");
  });
  it("keeps the selected accrual label while using native SQL without schedules", async () => {
    const f = fixture(true, false, "accrual");
    const result = await withReportingRead(f.source, "owner", async () => {
      expect(currentReportingRead("owner")?.basis).toBe("accrual");
      expect(reportingExecutionBasis("owner")).toBe("cash");
      expect(await resolveReportingExecution(f.manager, "owner")).toBe("cash");
      return { total: 0 };
    });
    expect(result).toEqual({ total: 0, basis: "accrual" });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(currentReportingRead("owner")).toBeUndefined();
  });
  it("memoizes schedule presence per authorized account scope within one read only", async () => {
    const f = fixture(true, true, "accrual");
    const read = () =>
      withReportingRead(f.source, "owner", async () => {
        expect(reportingExecutionBasis("owner")).toBe("accrual");
        await resolveReportingExecution(f.manager, "owner", undefined, [
          "b",
          "a",
          "a",
        ]);
        await resolveReportingExecution(f.manager, "owner", undefined, [
          "a",
          "b",
        ]);
        expect(currentReportingRead("other")).toBeUndefined();
      });
    await read();
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[1][1]).toEqual(["owner", ["b", "a", "a"]]);
    await read();
    expect(f.query).toHaveBeenCalledTimes(4);
  });
  it("validates basis input before opening a read", async () => {
    const f = fixture(true);
    await expect(
      withReportingRead(f.source, "owner", async () => 0, "invalid" as "cash"),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});

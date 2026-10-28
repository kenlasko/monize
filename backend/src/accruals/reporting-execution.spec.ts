import type { EntityManager } from "typeorm";
import { executeReportingRead } from "./reporting-execution";
describe("transaction-local recognition query execution", () => {
  it("leaves cash queries and their settings untouched", async () => {
    const query = jest.fn();
    const read = jest.fn().mockResolvedValue("cash");
    expect(
      await executeReportingRead(
        { query } as unknown as EntityManager,
        "cash",
        read,
      ),
    ).toBe("cash");
    expect(query).not.toHaveBeenCalled();
  });
  it("restores the existing transaction setting after a successful read", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ jit: "on" }])
      .mockResolvedValue([]);
    const read = jest.fn(async () => {
      expect(query).toHaveBeenLastCalledWith(
        "SELECT set_config('jit','off',true)",
      );
      return [7];
    });
    expect(
      await executeReportingRead(
        { query } as unknown as EntityManager,
        "accrual",
        read,
      ),
    ).toEqual([7]);
    expect(query).toHaveBeenLastCalledWith("SELECT set_config('jit',$1,true)", [
      "on",
    ]);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("preserves an existing JIT opt-out without setting it again", async () => {
    const query = jest.fn().mockResolvedValue([{ jit: "off" }]);
    expect(
      await executeReportingRead(
        { query } as unknown as EntityManager,
        "accrual",
        async () => 2,
      ),
    ).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("preserves the original SQL failure for rollback instead of querying an aborted transaction", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ jit: "on" }])
      .mockResolvedValue([]);
    const failure = new Error("statement timeout");
    await expect(
      executeReportingRead(
        { query } as unknown as EntityManager,
        "accrual",
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

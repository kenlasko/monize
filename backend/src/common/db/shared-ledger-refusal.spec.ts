import { QueryFailedError } from "typeorm";
import { sharedLedgerRefusal } from "./shared-ledger-refusal";
import { bulkSkipReason } from "../bulk-create.types";
import { safeToolError } from "../../mcp/mcp-context";

describe("Shared ledger refusals across generic write adapters", () => {
  const error = (code: string) =>
    new QueryFailedError(
      "private SQL",
      ["private value"],
      Object.assign(new Error("private driver detail"), { code }),
    );
  it("explains the repair on direct MCP and bulk paths without database internals", () => {
    const refusal = error("PSE01");
    const message = sharedLedgerRefusal(refusal);
    expect(message).toContain("Shared expenses");
    expect(bulkSkipReason(refusal)).toBe(message);
    expect(safeToolError(refusal)).toEqual({
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    });
    expect(JSON.stringify(safeToolError(refusal))).not.toContain("private");
  });
  it("does not expose unrelated SQL errors or a plain object's message", () => {
    for (const failure of [
      error("23503"),
      new Error("PSE01"),
      { code: "PSE01", message: "private" },
      null,
    ]) {
      expect(sharedLedgerRefusal(failure)).toBeNull();
      expect(bulkSkipReason(failure)).toBe("Could not be saved.");
      expect(safeToolError(failure)).toMatchObject({
        isError: true,
        content: [
          { text: "Error: An error occurred while processing your request" },
        ],
      });
    }
  });
});

import { collectToolConfigs } from "./testing/collect-tool-configs";

// Tools that mutate state; everything else must be read-only.
const WRITE_TOOLS = new Set([
  "manage_transactions",
  "manage_payees",
  "manage_tags",
  "manage_securities",
  "manage_investment_transactions",
  "manage_transaction_rules",
  // Claims, proposes and releases queue rows; the ledger is written only by the
  // user's approval elsewhere, so it is a write tool that is not destructive.
  "ai_review_requests",
  // Reads stored emails and saves a DRAFT parser (it reads no mail until the
  // user approves it); never the ledger, so a write tool that is not destructive.
  "email_receipt_parsers",
  // Reference data from the issuer's official source (or an administrator's
  // hand); never the user's ledger, so a write tool that is not destructive.
  "fetch_bond_series",
  "enter_bond_series_manually",
]);
// Write tools whose repeated calls converge to the same state.
// A repeat of fetch_bond_series finds the stored series (created=false).
const IDEMPOTENT_WRITES = new Set<string>(["fetch_bond_series"]);
// The only tool that reads an external site; every other tool is closed-world.
const OPEN_WORLD_TOOLS = new Set<string>(["fetch_bond_series"]);
// Write tools that remove data (destructiveHint: true). The manage_* tools can
// delete, so they are destructive (and non-idempotent because they can also
// create).
const DESTRUCTIVE_TOOLS = new Set([
  "manage_transactions",
  "manage_payees",
  "manage_tags",
  "manage_securities",
  "manage_investment_transactions",
  "manage_transaction_rules",
]);

const EXPECTED_TOOL_COUNT = 29;

describe("MCP tool spec compliance", () => {
  const configs = collectToolConfigs();

  it("registers the expected number of tools", () => {
    expect(configs).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it("gives every tool a unique name", () => {
    const names = configs.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(collectToolConfigs())("$name", ({ name, config }) => {
    it("declares a human-readable title", () => {
      expect(typeof config.title).toBe("string");
      expect(config.title.length).toBeGreaterThan(0);
    });

    it("declares both an input and output schema", () => {
      expect(config.inputSchema).toBeDefined();
      expect(config.outputSchema).toBeDefined();
    });

    it("declares annotations over a closed (non-open-world) dataset, but for the tool that reads an external site", () => {
      expect(config.annotations).toBeDefined();
      expect(config.annotations.openWorldHint).toBe(OPEN_WORLD_TOOLS.has(name));
    });

    it("explicitly declares all four behavioural hints (no implicit defaults)", () => {
      // Every tool must spell out all four hints rather than relying on the
      // SDK's implicit defaults (destructiveHint defaults to true, which is
      // wrong for our read-only tools).
      expect(typeof config.annotations.readOnlyHint).toBe("boolean");
      expect(typeof config.annotations.destructiveHint).toBe("boolean");
      expect(typeof config.annotations.idempotentHint).toBe("boolean");
      expect(typeof config.annotations.openWorldHint).toBe("boolean");
    });

    it("sets read/write hints matching the tool's effect", () => {
      if (WRITE_TOOLS.has(name)) {
        expect(config.annotations.readOnlyHint).toBe(false);
        expect(config.annotations.destructiveHint).toBe(
          DESTRUCTIVE_TOOLS.has(name),
        );
        expect(config.annotations.idempotentHint).toBe(
          IDEMPOTENT_WRITES.has(name),
        );
      } else {
        // Read-only tools never mutate state, so they are non-destructive and
        // idempotent by definition.
        expect(config.annotations.readOnlyHint).toBe(true);
        expect(config.annotations.destructiveHint).toBe(false);
        expect(config.annotations.idempotentHint).toBe(true);
      }
    });
  });
});

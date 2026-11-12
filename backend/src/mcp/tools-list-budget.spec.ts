import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { collectToolConfigs } from "./testing/collect-tool-configs";
import { McpServerService } from "./mcp-server.service";

/**
 * Every byte of `tools/list` rides in the model's context on EVERY request, and
 * the server instructions ride beside it. Nothing measured that, so the payload
 * grew to ~11,600 tokens for 20 tools: each defect fix appended a paragraph, the
 * same fact was stated in the tool description AND the field description AND the
 * instructions, and enum members were spelled out in prose beside the `z.enum`
 * that already carries them.
 *
 * This spec serializes the real `tools/list` through the SDK (the same
 * JSON-Schema conversion a client receives) and fails when a tool, the total, or
 * the instructions exceed their budget. Raising a cap is a reviewed decision,
 * not a fix for a failing build.
 */

// Bytes of serialized JSON per tool in the `tools/list` result, pinned to the
// measured size. A cap is a ratchet: lower it when a tool shrinks, and raise one
// only as a reviewed decision. The whole table dropped ~9% when the server moved
// to the v2 SDK, whose Standard JSON Schema emission is more compact than the
// 1.x converter -- the definitions did not change, so the caps came down with
// the measurement rather than banking the slack.
//
// Raised, as a reviewed decision: `list_accounts` now states every balance in
// the user's default currency beside its own (and names the pairs it could
// not price), and `calculate` gained the `convert` operation -- a currency
// pair and a rate date on the input, the rate and its date on the output. Both
// exist so a model never converts a currency itself, which is worth the bytes.
//
// Raised, as a reviewed decision (owner-approved with the tools): the rule tool
// `manage_transaction_rules` (3,896 bytes: the rule language a model must be
// told to write a condition and its actions, plus the shared A1 field shapes)
// and the review-queue tool `ai_review_requests` (2,981 bytes: four operations
// and the split-line shape of a proposal). Total 51,600 -> 58,480 = the two
// tools (6,877 bytes) plus the previous 72-byte margin; no existing cap moved.
//
// Raised, as a reviewed decision (owner-approved with rule captures, design
// 10.1 and 10.2): `manage_transaction_rules` states the two text actions
// (`set_payee_from_text`, `set_description`) and the `{name}` capture syntax a
// model must be told to write them. 3,896 -> 4,217 bytes (+321); cap 3,950 ->
// 4,250 and total 58,480 -> 58,800 (58,726 measured, the previous margin kept).
//
// Raised, as a reviewed decision (owner-approved with the X3 condition fields,
// design 10.3): the rule language lists five more fields with their operators
// (generated from the field table) and the values a model must write for
// `weekday`, `dayOfMonth`, `status` and the two booleans. 4,217 -> 4,522 bytes
// (+305); cap 4,250 -> 4,560 and total 58,800 -> 59,110 (59,031 measured).
//
// Reshaped, as a reviewed decision (owner-approved, after Claude Code logged
// `description truncated from 2328 to 2048 chars` and the model then guessed
// the rule shape): the rule tool's description is now the contract only (1,877
// characters, under the 2,048 clients keep) and the per-field detail moved into
// the `condition` and `actions` field descriptions, which cost bytes of their
// own. 4,522 -> 4,596 bytes measured (+74); cap 4,560 -> 4,600; the total
// (59,105 measured) stays under 59,110.
//
// Reworded again (owner-approved): the regex advice now says which characters
// are matched literally (`|`, a backslash, `.*`, a short `[xy]` class) and that
// `^`, `$` and longer bracketed words are allowed. 4,596 -> 4,647 bytes
// measured (+51); cap 4,600 -> 4,660; total 59,110 -> 59,170 (59,156 measured).
//
// Reworded for the zero-match fix (owner-approved): the guide now says that
// `conditionMatchedCount` 0 means the rule is wrong while `matchedCount` 0
// beside a matching condition is not an error, and the field descriptions
// regain the true|false, unsigned absAmount and capture-name guidance the
// rewrite dropped. 4,647 -> 4,904 bytes measured (+257); cap 4,660 -> 4,910;
// total 59,170 -> 59,420 (59,413 measured).
//
// Added, as a reviewed decision (email-receipts, "draft a parser with AI"): the
// tool `email_receipt_parsers` (2,606 bytes: three operations and the compact
// parser language a model must be told to write and test a parser from stored
// order emails; its input and output schemas declare only what a model reasons
// about). Total 59,420 -> 62,040 = the new tool plus a 14-byte margin; NO
// existing cap moved, and `ai_review_requests` did not grow to describe the new
// request kind (its claim result carries that guidance).
//
// Added, as a reviewed decision (bond series fetch, docs/specs/bond-series-fetch.md
// section 5): `fetch_bond_series` (998 bytes: a country and a series code, the
// instrument and `created` back) and the administrator's
// `enter_bond_series_manually` (1,685 bytes: the per-series values of a template).
// Total 62,040 -> 63,050 (63,046 measured, a 4-byte margin); no existing cap moved.
// Approved by the owner on 2026-10-11 (WMP/monize#24).
//
// Raised, as a reviewed decision (owner-approved): `email_receipt_parsers`
// gained the read-only `get` operation (the saved parsers, or one in full with
// `parserId`) so an agent revising a profile reads the previous version instead
// of the 200-character excerpt a queued instruction carries. Now 2,730
// bytes measured; cap 2,620 -> 2,740 and total 63,050 -> 63,170 (63,158
// measured); no other cap moved.
//
// Raised, as a reviewed decision approved by the maintainer (linked receipts spec
// 10a: `test` takes `componentDrafts` on the MCP surface too): the new input
// field `componentDrafts` (an array of {definition, fromDomains}, no prose: the
// language guide explains it). `email_receipt_parsers` 2,730 -> 3,023 bytes
// measured (+293); cap 2,740 -> 3,030 and total 63,170 -> 63,460 (63,451
// measured); no other cap moved.
//
// Added, as a reviewed decision (warranty tracker, design decision 11): the
// read-only `list_warranties` (1,135 bytes: a status, a search and a limit in;
// `today`, the rows and `total` out). Total 63,460 -> 64,595 = exactly the
// new tool's measured bytes (64,586 measured, the previous 9-byte margin
// kept); no existing cap moved.
//
// Added, as a reviewed decision (in-app help plan 6,
// docs/future-plans/in-app-help-assistant-tool.md; the owner chose to make
// room rather than raise the total): the read-only `search_help` (1,082
// bytes: a question and a limit in, `available` and the cited sections out).
// The room came from trimming nine descriptions of restated wording and of
// facts the server instructions already give every tool (names resolve
// internally), keeping every rule they state: list_upcoming_bills -316,
// manage_transactions -195, list_payees -119, manage_payees -94,
// report_progress -68, list_accounts -49, get_portfolio_summary -47,
// get_next_prompt -23, manage_securities -19. Their caps came down with them.
// Total unchanged at 64,595 (64,580 measured).
//
// Raised, as a reviewed decision (MCP tag tools, issue #2094; the owner chose
// to raise the total by the measured bytes, as for list_warranties):
// `manage_transactions` takes `addTagNames` and `removeTagNames` on an update
// and a `splitId` on a split line, whose tags it keeps, with one sentence in
// the description. 5,592 -> 6,102 bytes measured (+510); cap 5,600 -> 6,110;
// total 64,595 -> 65,105 (65,090 measured, the 15-byte margin kept).
//
// Added, as the same reviewed decision (issue #2094): the read-only
// `list_tags` (986 bytes: a search and a limit in, the tags with their use
// out) and `manage_tags` (2,367 bytes: create, rename, recolour or delete tags
// by name, on the shared manage_* envelope). Total 65,105 -> 68,458 = exactly
// the two tools' measured bytes (68,443 measured, the 15-byte margin kept); no
// existing cap moved.
//
// Raised, as the follow-up the #2094 decision left open (tags on split
// lines), by the measured bytes as before: `manage_transactions` takes
// `splitTags` on an update (per existing line: a splitId and the names to add
// and remove), with one clause in the description. 6,102 -> 6,626 bytes
// measured (+524); cap 6,110 -> 6,634; total 68,458 -> 68,982 (68,966
// measured, the margin kept).
//
// Raised, by the measured bytes as for #2094 (issue #2132, foreign-currency
// entries): `manage_transactions` takes `originalAmount` and
// `originalCurrencyCode` on a non-transfer create or update, and
// `exchangeRate`'s description now covers them too; no description sentence
// was added. 6,626 -> 7,020 bytes measured (+394); cap 6,634 -> 7,028.
// `list_transactions` no longer calls those fields read-only (-10 bytes). Total
// 68,982 -> 69,366 (69,350 measured, the margin kept).
const TOOL_BYTE_BUDGET: Record<string, number> = {
  list_accounts: 2360,
  list_transactions: 3550,
  compare_periods: 1900,
  manage_transactions: 7028,
  list_categories: 1200,
  list_payees: 2010,
  manage_payees: 2860,
  generate_report: 2800,
  get_portfolio_summary: 2880,
  list_investment_transactions: 2450,
  list_capital_gains: 2050,
  lookup_securities: 1550,
  manage_securities: 4080,
  manage_investment_transactions: 4500,
  list_upcoming_bills: 2510,
  calculate: 2000,
  get_budget_status: 2550,
  manage_transaction_rules: 4910,
  ai_review_requests: 3050,
  email_receipt_parsers: 3030,
  fetch_bond_series: 1000,
  enter_bond_series_manually: 1690,
  list_warranties: 1140,
  search_help: 1090,
  list_tags: 990,
  manage_tags: 2370,
  get_next_prompt: 1360,
  post_response: 1050,
  report_progress: 1140,
};

const TOTAL_BYTE_BUDGET = 69_366;
const INSTRUCTIONS_BYTE_BUDGET = 2_600;

/**
 * The order the SDK lists tools in, which follows the registration order in
 * `mcp-server.service.ts`. MCP revision 2026-07-28 asks servers to return
 * `tools/list` in a deterministic order; this pins ours so a reordered
 * registration is a visible decision (clients cache the list).
 */
const EXPECTED_TOOL_ORDER = [
  "list_accounts",
  "list_transactions",
  "compare_periods",
  "manage_transactions",
  "list_categories",
  "list_payees",
  "manage_payees",
  "generate_report",
  "get_portfolio_summary",
  "list_investment_transactions",
  "list_capital_gains",
  "lookup_securities",
  "manage_securities",
  "manage_investment_transactions",
  "list_upcoming_bills",
  "calculate",
  "get_budget_status",
  "manage_transaction_rules",
  "ai_review_requests",
  "email_receipt_parsers",
  "fetch_bond_series",
  "enter_bond_series_manually",
  "list_warranties",
  "search_help",
  "list_tags",
  "manage_tags",
  "get_next_prompt",
  "post_response",
  "report_progress",
];

/**
 * Phrases that describe the codebase's history or another surface rather than
 * telling the model how to use the tool. Each one is paid for on every request.
 */
const BANNED_DESCRIPTION_PHRASES: Array<{ phrase: string; why: string }> = [
  {
    phrase: "Returns the same shape as the AI Assistant",
    why: "an MCP client cannot see the AI Assistant's tools",
  },
  {
    phrase: "Shares the lookup logic with the AI Assistant",
    why: "an MCP client cannot see the AI Assistant's tools",
  },
  {
    phrase: "replaces the former",
    why: "renamed-tool history guides nobody",
  },
  {
    phrase: "This single tool replaces",
    why: "renamed-tool history guides nobody",
  },
];

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

async function listRealTools(): Promise<{
  tools: ListedTool[];
  bytesByTool: Map<string, number>;
}> {
  const server = new McpServer(
    { name: "monize-budget", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const { name, config } of collectToolConfigs()) {
    server.registerTool(name, config, () => ({
      content: [{ type: "text" as const, text: "{}" }],
      structuredContent: {},
    }));
  }

  const client = new Client(
    { name: "budget-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const listed = await client.listTools();
    const bytesByTool = new Map<string, number>();
    for (const tool of listed.tools) {
      bytesByTool.set(tool.name, JSON.stringify(tool).length);
    }
    return { tools: listed.tools as ListedTool[], bytesByTool };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Bytes per token for this payload, calibrated against a real tokenizer: the
 * 78,207-byte baseline measured here was reported as 11,602 tokens, so the
 * naive bytes/4 rule overstates it by two thirds. JSON with repeated keys and
 * structure tokenizes far better than prose.
 */
const BYTES_PER_TOKEN = 6.7;

/** A table of every tool's size, so the numbers are visible in the failure. */
function sizeTable(bytesByTool: Map<string, number>): string {
  const rows = [...bytesByTool.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, bytes]) => sum + bytes, 0);
  const lines = rows.map(([name, bytes]) => {
    const budget = TOOL_BYTE_BUDGET[name];
    const flag = budget !== undefined && bytes > budget ? "  OVER" : "";
    return `  ${name.padEnd(32)} ${String(bytes).padStart(6)} bytes  ~${String(
      Math.round(bytes / BYTES_PER_TOKEN),
    ).padStart(5)} tokens (budget ${budget ?? "unset"})${flag}`;
  });
  lines.push(
    `  ${"TOTAL".padEnd(32)} ${String(total).padStart(6)} bytes  ~${String(
      Math.round(total / BYTES_PER_TOKEN),
    ).padStart(5)} tokens (budget ${TOTAL_BYTE_BUDGET})`,
  );
  return `\ntools/list payload:\n${lines.join("\n")}\n`;
}

/** Every enum in a serialized JSON Schema, keyed by the property that holds it. */
function enumsByProperty(schema: unknown): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (node: unknown, propertyName: string | null) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum) && propertyName) {
      const members = obj.enum.filter(
        (v): v is string => typeof v === "string",
      );
      if (members.length >= 3) found.set(propertyName, members);
    }
    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, value] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        walk(value, key);
      }
    }
    if (obj.items) walk(obj.items, propertyName);
  };
  walk(schema, null);
  return found;
}

/** Every `description` in a serialized JSON Schema, keyed by its property. */
function describesByProperty(schema: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (node: unknown, propertyName: string | null) => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.description === "string" && propertyName) {
      found.set(propertyName, obj.description);
    }
    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, value] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        walk(value, key);
      }
    }
    if (obj.items) walk(obj.items, propertyName);
  };
  walk(schema, null);
  return found;
}

/**
 * Does `text` copy out an enum's member LIST, rather than merely using words
 * that happen to be members? A restated list runs member -> separator ->
 * member; ordinary prose puts other words between them.
 */
function restatesList(text: string, members: string[]): boolean {
  const escaped = members
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const hits = [...text.matchAll(new RegExp(`\\b(${escaped})\\b`, "g"))];
  let run: string[] = [];
  let previousEnd = -1;
  for (const hit of hits) {
    const gap = previousEnd < 0 ? "" : text.slice(previousEnd, hit.index);
    const isSeparator =
      /^[\s,/|'"()\][-]*(?:or|and|then)?[\s,/|'"()\][-]*$/.test(gap);
    run = previousEnd >= 0 && isSeparator ? [...run, hit[1]] : [hit[1]];
    if (new Set(run).size >= 3) return true;
    previousEnd = (hit.index ?? 0) + hit[0].length;
  }
  return false;
}

describe("tools/list payload budget", () => {
  let tools: ListedTool[];
  let bytesByTool: Map<string, number>;

  beforeAll(async () => {
    ({ tools, bytesByTool } = await listRealTools());
  });

  it("keeps every tool within its byte budget", () => {
    const report = sizeTable(bytesByTool);
    const over = [...bytesByTool.entries()]
      .filter(([name, bytes]) => {
        const budget = TOOL_BYTE_BUDGET[name];
        return budget === undefined || bytes > budget;
      })
      .map(
        ([name, bytes]) =>
          `${name}: ${bytes} bytes exceeds budget ${TOOL_BYTE_BUDGET[name] ?? "(unset)"}`,
      );

    // Compared against the report itself so a failure prints the whole table.
    expect(
      over.length === 0
        ? report
        : `${report}\nOVER BUDGET:\n${over.join("\n")}`,
    ).toBe(report);
  });

  it("keeps the whole payload within the total budget", () => {
    const report = sizeTable(bytesByTool);
    const total = [...bytesByTool.values()].reduce((a, b) => a + b, 0);
    const verdict =
      total <= TOTAL_BYTE_BUDGET
        ? report
        : `${report}\nTOTAL ${total} exceeds budget ${TOTAL_BYTE_BUDGET}`;
    expect(verdict).toBe(report);
  });

  it("keeps the server instructions within budget", () => {
    // The instructions are built independently of tool registration, so empty
    // provider doubles are enough to read them back off the server.
    const noopProvider = { register: () => {} } as any;
    const service = new McpServerService(
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      {} as any,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
      noopProvider,
    );
    const server = service.createServer();
    const instructions = (server.server as any)._instructions as string;

    expect(typeof instructions).toBe("string");
    const verdict =
      instructions.length <= INSTRUCTIONS_BYTE_BUDGET
        ? "within budget"
        : `instructions are ${instructions.length} bytes (~${Math.round(instructions.length / BYTES_PER_TOKEN)} tokens), budget ${INSTRUCTIONS_BYTE_BUDGET}`;
    expect(verdict).toBe("within budget");
  });

  it("lists tools in a deterministic, pinned order", () => {
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOL_ORDER);
  });
  it("never restates an enum's members in prose", () => {
    // A `z.enum` already ships its members in the JSON Schema, so listing them
    // again in prose pays for the list twice. What counts as restating is the
    // LIST, not the words: "create, edit or delete" is ordinary English about
    // what the tool does, while "'bill', 'deposit', 'transfer'" is the enum
    // copied out. So a run of three or more members separated by nothing but
    // list punctuation is the offence, and the enum's OWN field may of course
    // explain its members.
    const offenders: string[] = [];
    for (const tool of tools) {
      const enums = enumsByProperty(tool.inputSchema);
      if (enums.size === 0) continue;
      const describes = describesByProperty(tool.inputSchema);
      for (const [property, members] of enums) {
        const restated = (text: string) => restatesList(text, members);
        if (tool.description && restated(tool.description)) {
          offenders.push(
            `${tool.name}: description restates the '${property}' enum`,
          );
        }
        for (const [otherProperty, text] of describes) {
          if (otherProperty !== property && restated(text)) {
            offenders.push(
              `${tool.name}: '${otherProperty}' describe restates the '${property}' enum`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps codebase history and sibling-surface references out of descriptions", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const { phrase, why } of BANNED_DESCRIPTION_PHRASES) {
        if (tool.description?.includes(phrase)) {
          offenders.push(`${tool.name}: "${phrase}" (${why})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every tool description within the length clients truncate at", () => {
    // Claude Code logs `Tool "manage_transaction_rules" description truncated
    // from 2328 to 2048 chars` and drops the tail, so whatever a description
    // says last is never read. The contract of a tool goes first and the whole
    // text stays under the limit; per-field detail belongs in the field's own
    // description.
    const MAX_CLIENT_DESCRIPTION_CHARS = 2048;
    const offenders = tools
      .filter(
        (t) => (t.description?.length ?? 0) > MAX_CLIENT_DESCRIPTION_CHARS,
      )
      .map(
        (t) =>
          `${t.name}: description is ${t.description?.length} chars; clients truncate a tool description at ${MAX_CLIENT_DESCRIPTION_CHARS} (the tail is lost). Move detail into the field descriptions.`,
      );
    expect(offenders).toEqual([]);
  });

  it("keeps the rule tool's contract inside the first 2,000 characters", () => {
    const rules = tools.find((t) => t.name === "manage_transaction_rules");
    const description = rules?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(2000);
    // The exact shape, the example and the glob rules are what a model got
    // wrong when the tail was cut off.
    for (const needle of [
      "condition is an OBJECT and actions an ARRAY",
      '{"field":"description","op":"contains","value":"ASSECO"}',
      '{"type":"set_category","categoryName"',
      "Leaf keys exactly field, op, value",
      "WHOLE text",
      "No regex",
    ]) {
      expect(description.indexOf(needle)).toBeGreaterThanOrEqual(0);
      expect(description.indexOf(needle)).toBeLessThan(1500);
    }
  });

  it("keeps every field description short enough to scan", () => {
    // An enum's own field is where its members are explained, so it is allowed
    // more room than a field that only says how to fill itself.
    const MAX_DESCRIBE_CHARS = 300;
    const MAX_ENUM_DESCRIBE_CHARS = 600;
    const offenders: string[] = [];
    for (const tool of tools) {
      const enums = enumsByProperty(tool.inputSchema);
      for (const [property, text] of describesByProperty(tool.inputSchema)) {
        const cap = enums.has(property)
          ? MAX_ENUM_DESCRIBE_CHARS
          : MAX_DESCRIBE_CHARS;
        if (text.length > cap) {
          offenders.push(`${tool.name}.${property}: ${text.length} > ${cap}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

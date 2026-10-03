import { ruleErrorHint, ruleErrorHints } from "./rule-validation-hints";
import { validateRuleDefinition } from "./rule-validation";

const SPLIT_ACTION = {
  type: "split",
  parts: [{ amount: "{principal}" }, { amount: "rest" }],
};

describe("hints for the structural actions", () => {
  it("lists the name-form keys of both actions", () => {
    const convert = ruleErrorHint(
      { path: "actions[0].toAccountId", code: "UNKNOWN_KEY" },
      { actions: [{ type: "convert_to_transfer" }] },
    );
    expect(convert).toContain(
      "toAccountName, fromAccountName, clearCategory, payeeName",
    );
    const split = ruleErrorHint(
      { path: "actions[0].extra", code: "UNKNOWN_KEY" },
      { actions: [{ type: "split" }] },
    );
    expect(split).toContain("split takes only type, payeeName, parts");
  });

  it("lists the keys of a split part", () => {
    expect(
      ruleErrorHint(
        { path: "actions[0].parts[1].extra", code: "UNKNOWN_KEY" },
        { actions: [{ type: "split", parts: [{}, { extra: 1 }] }] },
      ),
    ).toContain("amount, categoryName, transferTo, payeeName, description");
  });

  it("tells the model the form of the parts and where a capture comes from", () => {
    expect(
      ruleErrorHint({ path: "actions[0].parts", code: "ARRAY_EMPTY" }),
    ).toContain("2 to 10 parts");
    expect(
      ruleErrorHint({ path: "actions[0].parts", code: "ARRAY_TOO_LARGE" }),
    ).toContain("at most 10");
    expect(
      ruleErrorHint({
        path: "actions[0].parts[0].amount",
        code: "INVALID_SHAPE",
      }),
    ).toContain('"rest"');
    expect(
      ruleErrorHint({
        path: "actions[0].parts[0].amount",
        code: "UNKNOWN_CAPTURE",
      }),
    ).toContain("{principal}");
    // A template's hint is unchanged.
    expect(
      ruleErrorHint({ path: "actions[0].template", code: "UNKNOWN_CAPTURE" }),
    ).toContain("{payeeText}");
  });

  it("explains each conflict", () => {
    const conflict = (path: string, actions: unknown[] = []) =>
      ruleErrorHint({ path, code: "CONFLICTING_ACTIONS" }, { actions }) ?? "";
    expect(
      conflict("actions[0]", [
        {
          type: "convert_to_transfer",
          toAccountName: "A",
          fromAccountName: "B",
        },
      ]),
    ).toContain("toAccountName (an expense) or fromAccountName");
    expect(
      conflict("actions[0]", [
        { type: "convert_to_transfer", toAccountName: "A" },
        { type: "set_category", categoryName: "C" },
      ]),
    ).toContain("must not also have set_category");
    expect(conflict("actions[0]")).toContain("must not also have set_category");
    expect(conflict("actions[0].parts[0]")).toContain("not both");
    expect(
      ruleErrorHint({
        path: "actions[0].parts[1].amount",
        code: "DUPLICATE_ACTION",
      }),
    ).toContain("Only one part");
    expect(
      ruleErrorHint({ path: "actions[1]", code: "DUPLICATE_ACTION" }),
    ).toContain("convert_to_transfer or split");
    expect(
      ruleErrorHint({ path: "actions[0].toAccountId", code: "VALUE_REQUIRED" }),
    ).toContain("fromAccountName");
    expect(
      ruleErrorHint({ path: "condition.value", code: "VALUE_REQUIRED" }),
    ).toContain("only isEmpty");
  });

  it("produces a hint for what the validator reports on a split with an unknown capture", () => {
    const errors = validateRuleDefinition({
      condition: {
        all: [{ field: "description", op: "contains", value: "x" }],
      },
      actions: [SPLIT_ACTION],
    });
    expect(errors).toEqual([
      { path: "actions[0].parts[0].amount", code: "UNKNOWN_CAPTURE" },
    ]);
    expect(ruleErrorHints(errors, { actions: [SPLIT_ACTION] })).toHaveLength(1);
  });
});

---
title: "trail check false positives: learnMore forwarding is intended, not ruled out"
author: Node
date: 2026-11-07
branch: claude/issue-2055
cost: { minutes: 1, tokens: 12405 }
---

## Decided
- `trail check` on this branch flags RuleSection.tsx, RuleTestPanel.tsx, RunRuleDialog.tsx, SecuritySection.tsx and Modal.tsx as conflicting with the "In-app help batch 5d" learning's "Tried and ruled out" bullet about `learnMore`/`descriptionLearnMore`. This is a false positive from that bullet's own double-negative phrasing ("considered NOT forwarding... but decided to forward anyway") — the semantic matcher keys on "ruled out: forwarding learnMore through shared components" and flags the code that actually does the forwarding, even though forwarding it IS the decision that shipped.
- Also flagged: CsvColumnMappingStep.tsx:290 against Ken's unrelated Oct 31 learning about AccountList's Name+Balance+Actions column-width tiers. The matched line only adds an InfoTooltip next to a "Column Mapping" heading text — no table columns, widths or tiers are touched. Another false positive, on surface wording overlap ("column", "name").

## Watch out
- When writing a "Tried and ruled out" bullet that describes rejecting the *opposite* of what shipped, phrase it as what was rejected, not as "considered not doing X" — the negation reads back as a rule against doing X to the conflict matcher on a later run.

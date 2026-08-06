# Architecture Decision Records

A record of decisions that shape the system, why they were made, and what was
rejected. They exist because this project's significant decisions have mostly
been recorded in three places that do not survive: a code comment beside one
call site, a `CLAUDE.md` rule stated without its reasoning, and a
`docs/future-plans/` file describing an intention that has since partly shipped.

An ADR is not documentation of how something works -- `docs/` and the
`CLAUDE.md` files do that. An ADR records **why**, so that a future change can
tell whether it is revisiting a decision or violating one by accident.

## When to write one

Write an ADR when a decision:

- constrains code that has not been written yet (a rule every future call site
  must follow);
- rejects a plausible alternative for a reason that will not be obvious from the
  result;
- is expensive to reverse;
- or would otherwise be inferred only from a comment beside one of its many call
  sites.

Do not write one for a decision a type, a lint rule or a test already enforces
and explains. Per root `CLAUDE.md`, prefer the highest enforcement the mistake
allows; an ADR is prose, so it is for the part that genuinely needs judgement --
the reasoning behind the rule the machine checks.

## Format

Numbered, four digits, `NNNN-short-slug.md`. Numbers are never reused. Sections:

```markdown
# NNNN. Title

Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context
The forces at play. What made a decision necessary.

## Decision
What was decided, stated so a reviewer can check a diff against it.

## Consequences
What this makes easy, what it makes hard, and what it forbids.

## Alternatives considered
Each with the reason it was rejected. This is the section that stops a
decision being relitigated from scratch every year.
```

A superseded ADR is **never deleted or edited into agreement with its
replacement**. Change its status line to point at the successor and leave the
reasoning intact -- the record of what was believed, and why it changed, is the
whole value.

A retrospective ADR -- one recording a decision already implemented -- is
worth writing when the reasoning exists nowhere durable. Mark it as such on the
`Date` line so nobody reads it as a decision taken that day. 0001 and 0003 below
are both retrospective.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-scoped-db-single-database-door.md) | `withScopedDb` is the only door to the database | accepted |
| [0002](0002-invariant-catalog-and-enforcement-ranking.md) | Invariants are catalogued, and enforced as low in the stack as possible | accepted |
| [0003](0003-filesystem-objects-use-id-sharding.md) | Filesystem objects use the shared ID-sharding scheme | accepted |

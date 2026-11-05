# Tasks: cross-currency transfer lines in a split

Plan: [`split-cross-currency-transfer.md`](./split-cross-currency-transfer.md). Spec:
[`docs/specs/split-cross-currency-transfer.md`](../specs/split-cross-currency-transfer.md).

- [x] `transferTargetAmount` on a split line: DTO, conversion, refusals.
- [x] Counterpart amount in `findOne` and the register, own rows only.
- [x] Carry a continuing line's recorded received amount on every replacement.
- [x] Undo sees a change to what a line received.
- [x] Split editor: labelled pair, prefill, fee direction, currency precision.
- [x] Received amount tagged with its parent currency; none copied by a duplicate or quick fill.
- [x] User documentation and `docs/financial-semantics.md`.
- [x] Translate the new error message into every locale.
- [ ] Screenshot of a split with a cross-currency transfer line (needs the E2E stack).
- [ ] Received amounts on scheduled transaction splits (own tables; out of scope).

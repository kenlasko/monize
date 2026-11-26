# Report sign conventions task list

Working draft for [#2404](https://github.com/kenlasko/monize/discussions/2404). The [contract](../specs/report-sign-conventions.md) defines expected values. The [plan](report-sign-conventions.md) names the implementation areas.

- [x] Trace the current Both / Total Amount settlement and its dedicated signed transaction-list path. Locate the saved configuration, unsigned labels and existing tests.
- [x] Reproduce positive, negative and zero headline cases using the normal report service entry point and compare the results to independently calculated values.
- [ ] Agree with Ken on applying the new definition to previously saved reports, the scope of the first behavior change, and its release boundary. Record approval on the discussion or its tracking issue.
- [ ] Agree with #2403 on transfer legs, split identity and overlapping tags. Cover whole-population and one-account controls.
- [x] Implement the proposed shared calculation for signed Both / Total Amount and document INV-REPORT-003 and INV-REPORT-004. Exercise other metrics as controls.
- [x] Update signed labels, chart handling, and table and export tests in tandem with the backend. Test a pre-existing saved report using its stored direction, metric and sort settings.
- [ ] Verify income and expense classification in the relevant built-in reports, including returns exceeding purchases. Audit their dashboard, analytics and export consumers.
- [ ] Carry negative actual spending through the budget calculation and its documented variance formula.
- [ ] Run the agreed cross-report scenarios at the release boundary, document any changes visible in saved reports, and link verification to the discussion.

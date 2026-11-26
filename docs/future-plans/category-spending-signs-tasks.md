# Signed category spending tasks

Follow the [implementation plan](category-spending-signs.md) and [financial definition](../specs/category-spending-signs.md).

- [x] In Spending by Category, net the purchase and refund within their assigned expense category. Cover partial, full and excess refunds, split postings and parent rollup in PostgreSQL.
- [x] Apply the category inclusion rule in Monthly Spending Trend, the assistant’s category breakdown and period comparison, and AI insights. Keep the purchase-only payee population.
- [x] Preserve signed amounts in the report and dashboard. Withhold unavailable shares and percentage growth from a net-credit baseline.
- [x] Check trivia against complete spending figures before describing the amount spent or its share.
- [x] Cover Cash Flow's Spending After Refunds by Category table and its PDF rows with a 100 purchase and a 150 refund.
- [ ] Run the pre-push checks and address review feedback on the tested revision.

/**
 * The row-per-page ceiling the paged list endpoints enforce, held once on the
 * client so a call site cannot pick a number the server will refuse.
 *
 * The server does not clamp an over-cap `limit` -- it rejects the request. Both
 * `GET /transactions` (via `PAGINATION_MAX_LIMIT` in
 * `backend/src/common/dto/pagination-query.dto.ts`) and
 * `GET /investment-transactions` (a hand-written check in
 * `backend/src/securities/investment-transactions.controller.ts`) answer 400 to
 * a larger one. Every such call in this app sits behind a `.catch()` that
 * degrades to an empty list, so the 400 never reaches the user as an error: it
 * reaches them as a figure that is silently, permanently zero (issue #1229, and
 * the YTD income figure on the investment detail page).
 *
 * Asking for more rows than this is therefore never the answer. Walk the pages
 * instead -- `transactionsApi.getAllPages` and
 * `investmentsApi.getAllTransactionPages` both default their page size to this
 * constant -- or narrow the query so one page is enough.
 *
 * `src/test/api-page-limits.test.ts` scans the tree for a call site that
 * exceeds it and checks this value against both backend sources, so the two
 * layers cannot drift apart quietly.
 */
export const API_MAX_PAGE_LIMIT = 200;

/**
 * How many security ids one `POST /securities/prices/refresh/selected` takes
 * (`@ArrayMaxSize` on `RefreshSecurityPricesDto`). A longer list is refused
 * outright, so `investmentsApi.refreshSelectedPrices` sends one in consecutive
 * batches of this size; `src/test/api-page-limits.test.ts` checks it against
 * the DTO.
 */
export const REFRESH_SELECTED_MAX_IDS = 100;

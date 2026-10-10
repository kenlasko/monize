import { SetMetadata } from "@nestjs/common";

/**
 * Marks a route as reachable by a delegate who is acting as an owner.
 *
 * The default posture is fail-closed: while a request carries a delegate
 * "acting-as" context, AccountDelegateGuard rejects any route NOT annotated
 * with @AllowDelegate(). Normal (non-delegate) requests are unaffected.
 */
export const ALLOW_DELEGATE_KEY = "allowDelegate";
export const AllowDelegate = () => SetMetadata(ALLOW_DELEGATE_KEY, true);

/** Explicit owner-only policy; a method may override a class's delegate access. */
export const OwnerOnly = () => SetMetadata(ALLOW_DELEGATE_KEY, false);

/**
 * Marks a route as account-scoped for delegates. The value is the request key
 * holding the account id; the guard additionally requires an active READ grant
 * for that account. Lookup order: route params, then body, then query.
 */
export const DELEGATED_ACCOUNT_PARAM_KEY = "delegatedAccountParam";
export const DelegatedAccountParam = (key = "id") =>
  SetMetadata(DELEGATED_ACCOUNT_PARAM_KEY, key);

/**
 * The per-account operation a delegate route requires on the resolved
 * account. Defaults to "read" when absent. Pair with @DelegatedAccountParam.
 */
export type DelegateOperation = "read" | "create" | "edit" | "delete";
export const DELEGATE_OPERATION_KEY = "delegateOperation";
export const DelegateRequires = (operation: DelegateOperation) =>
  SetMetadata(DELEGATE_OPERATION_KEY, operation);

/**
 * Like @DelegatedAccountParam but the request key holds a TRANSACTION id; the
 * guard resolves that transaction's account and checks the grant against it.
 * Used for edit/delete-by-id where the account is not in the request.
 */
export const DELEGATED_TRANSACTION_PARAM_KEY = "delegatedTransactionParam";
export const DelegatedTransactionParam = (key = "id") =>
  SetMetadata(DELEGATED_TRANSACTION_PARAM_KEY, key);

/**
 * A transfer-create route: both body account ids (from/to) must satisfy the
 * required operation. Value is the [fromKey, toKey] body field names.
 */
export const DELEGATED_TRANSFER_BODY_KEY = "delegatedTransferBody";
export const DelegatedTransferBody = (
  fromKey = "fromAccountId",
  toKey = "toAccountId",
) => SetMetadata(DELEGATED_TRANSFER_BODY_KEY, [fromKey, toKey]);

/**
 * Every further account a write names in its BODY, beyond the one the route's
 * other decorators resolve: the delegate needs the route's operation on each
 * (strictly -- no cross-owner relaxation, because these rows are written as
 * the owner). A path is a dot-separated body key and a `[]` suffix walks an
 * array, so "splits[].transferAccountId" checks every split line. Only the
 * body is read: it is what the route's DTO binds.
 */
export const DELEGATED_BODY_ACCOUNTS_KEY = "delegatedBodyAccounts";
export const DelegatedBodyAccounts = (...paths: string[]) =>
  SetMetadata(DELEGATED_BODY_ACCOUNTS_KEY, paths);

/**
 * A transfer edit/delete-by-id route: BOTH legs' accounts (resolved from the
 * transaction id) must satisfy the required operation.
 */
export const DELEGATED_TRANSFER_PARAM_KEY = "delegatedTransferParam";
export const DelegatedTransferParam = (key = "id") =>
  SetMetadata(DELEGATED_TRANSFER_PARAM_KEY, key);

/**
 * Like @DelegatedTransferParam but the request key holds a SCHEDULED
 * transaction id; the guard resolves every account it touches (its own
 * account plus the transfer counterpart) and requires the operation on each.
 * Used for scheduled read/edit/delete/post/skip + override routes.
 */
export const DELEGATED_SCHEDULED_PARAM_KEY = "delegatedScheduledParam";
export const DelegatedScheduledParam = (key = "id") =>
  SetMetadata(DELEGATED_SCHEDULED_PARAM_KEY, key);

/**
 * A scheduled READ whose answer discloses the other accounts' own figures,
 * not just their names (the loan occurrence projection answers the loan's
 * dated debt and rate). Pair with @DelegatedScheduledParam: the read then
 * needs READ on every account the schedule touches, as a write needs its
 * operation, because the interceptor masks a counterpart's name and nothing
 * else.
 */
export const DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY =
  "delegatedScheduledReadsEveryAccount";
export const DelegateReadsEveryScheduledAccount = () =>
  SetMetadata(DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY, true);

/**
 * 2C: a route that creates/edits/deletes shared reference data (payees,
 * categories, tags). A delegate may reach it only if the owner granted the
 * matching per-delegation manage capability.
 */
export type DelegateResource = "payees" | "categories" | "tags";
export type DelegateCapabilityOp = "create" | "edit" | "delete";
export interface DelegateCapabilityReq {
  resource: DelegateResource;
  operation: DelegateCapabilityOp;
}
export const DELEGATE_CAPABILITY_KEY = "delegateCapability";
export const DelegateRequiresCapability = (
  resource: DelegateResource,
  operation: DelegateCapabilityOp,
) => SetMetadata(DELEGATE_CAPABILITY_KEY, { resource, operation });

/**
 * 3A: a route belonging to a whole app section a delegate can be granted
 * READ on (Bills & Deposits, Investments, Budgets, Reports, AI). A delegate
 * may reach it only if the owner granted that section. Pair with
 * @AllowDelegate(); account-scoped data still also needs the per-account
 * decorators.
 */
export type DelegateSection =
  "bills" | "investments" | "budgets" | "reports" | "ai";
export const DELEGATE_SECTION_KEY = "delegateSection";
export const DelegateRequiresSection = (section: DelegateSection) =>
  SetMetadata(DELEGATE_SECTION_KEY, section);

/**
 * A route whose answer draws on the owner's WHOLE ledger and cannot be
 * narrowed to a delegate's grants (the AI assistant reads every account and
 * section through its tools). A delegate may reach it only when the
 * delegation grants READ on every one of the owner's accounts and every
 * section, so the route reveals nothing the delegate could not already open
 * elsewhere.
 */
export const DELEGATE_FULL_SCOPE_KEY = "delegateFullScope";
export const DelegateRequiresFullScope = () =>
  SetMetadata(DELEGATE_FULL_SCOPE_KEY, true);

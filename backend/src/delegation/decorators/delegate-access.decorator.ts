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
 * A transfer edit/delete-by-id route: BOTH legs' accounts (resolved from the
 * transaction id) must satisfy the required operation.
 */
export const DELEGATED_TRANSFER_PARAM_KEY = "delegatedTransferParam";
export const DelegatedTransferParam = (key = "id") =>
  SetMetadata(DELEGATED_TRANSFER_PARAM_KEY, key);

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

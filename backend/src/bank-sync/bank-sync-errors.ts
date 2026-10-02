import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describeFetchFailure } from "../common/http/fetch-failure.util";
import { tr } from "../i18n/translate";
import { BANK_SYNC_STORED_MESSAGE_MAX_LENGTH } from "./bank-sync.constants";
import type {
  BankSyncAccountFailure,
  BankSyncConnectionSyncEntry,
} from "./bank-sync.types";
import {
  BankSyncProviderError,
  isBankSyncProviderError,
} from "./providers/bank-sync-provider.errors";

/**
 * Where a failed provider call becomes something a caller can act on: an HTTP
 * exception whose message is translated, a bounded line to store on the row,
 * and a log line. Every kind is mapped here so a service never decides a status
 * code ad hoc (docs/specs/bank-sync.md section 7 step 7).
 */

/**
 * The stored provider credentials cannot be used: none are stored, or the
 * stored key can no longer be decrypted. A `BadRequestException` as before, so
 * an HTTP caller sees the same 400; its own class so a caller that reports a
 * failure as data (`describeFailureForClient`) can tell it from every other
 * refusal and name it `credentials`.
 */
export class BankSyncCredentialsUnavailableException extends BadRequestException {}

/**
 * Another sync of the same bank account holds its lease. A 409 as before, its
 * own class so a caller reporting failures as data can tell "someone else is
 * syncing it" from a refusal or a failure: the daily sync neither reports nor
 * records it (the lease holder's sync will).
 */
export class BankSyncAlreadyRunningException extends ConflictException {}

/** The code an account is reported under while another sync of it is running. */
export const SYNC_RUNNING_CODE = "sync_running";

/** The code of a bank account the sync skipped because it needs its preview. */
export const NEEDS_PREVIEW_CODE = "needs_preview";

/** The HTTP exception a provider failure is answered with. */
export function mapBankSyncProviderError(
  error: BankSyncProviderError,
): HttpException {
  switch (error.kind) {
    case "unauthorized":
      return new BadRequestException(
        tr(
          "errors.bankSync.credentialsRejected",
          "The bank sync provider rejected your application credentials. Check the application id and the private key.",
        ),
      );
    case "session_expired":
      return new ConflictException(
        tr(
          "errors.bankSync.consentExpired",
          "Your consent at the bank has expired or was withdrawn. Renew the connection to keep syncing.",
        ),
      );
    case "ip_not_allowed":
      return new BadRequestException(
        tr(
          "errors.bankSync.ipNotAllowed",
          "Enable Banking does not accept this server's IP address for your application. Allow this server's public IP address for the application at Enable Banking (or ask Enable Banking support to), then try again.",
        ),
      );
    case "no_accounts_linked":
      return new BadRequestException(
        tr(
          "errors.bankSync.noAccountsLinked",
          'Enable Banking returned no accounts for your application. A production application in restricted mode reads only the accounts linked to it: link your bank accounts to the application ("Activate by linking accounts") in the Enable Banking control panel, then connect again.',
        ),
      );
    case "period_unavailable":
      return new BadRequestException(
        tr(
          "errors.bankSync.periodUnavailable",
          "The bank does not provide transactions for that period. Many banks provide only the last 90 days, except during the first hour after you authorize access. Set a later cut-off date for this bank account and sync again.",
        ),
      );
    case "rate_limited":
      return new HttpException(
        tr(
          "errors.bankSync.rateLimited",
          "The bank or the provider limited how often this account can be read. Banks allow only a few unattended reads a day; try again later.",
        ),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    case "bad_request":
      return new BadRequestException(
        tr(
          "errors.bankSync.providerRejected",
          `The bank sync provider rejected the request: ${error.message}`,
          { detail: error.message },
        ),
      );
    case "unavailable":
      return new ServiceUnavailableException(
        tr(
          "errors.bankSync.providerUnavailable",
          "The bank sync provider did not answer. Nothing was changed; try again later.",
        ),
      );
    case "invalid_response":
      return new BadGatewayException(
        tr(
          "errors.bankSync.providerInvalidResponse",
          "The bank sync provider sent an answer this version of Monize does not understand.",
        ),
      );
  }
}

/**
 * The error a caller should throw for a failure caught in a sync step: a
 * provider failure is mapped, anything else (an HTTP exception a service threw,
 * or an unexpected error the global filter will report as a 500) passes
 * through unchanged.
 */
export function toBankSyncException(error: unknown): unknown {
  return isBankSyncProviderError(error)
    ? mapBankSyncProviderError(error)
    : error;
}

/** The text of an HTTP exception's response, or its own message. */
function httpExceptionText(error: HttpException): string {
  const body = error.getResponse();
  return typeof body === "string"
    ? body
    : typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : error.message;
}

const UNEXPECTED_FAILURE_TEXT =
  "The sync failed unexpectedly. The server log has the details.";

/**
 * The one line stored on a row (`last_sync_error`, `last_error`) for a failure.
 *
 * Only text this code controls or that the provider layer promises is safe to
 * store (`BankSyncProviderError` is built from a status and a bounded provider
 * code, never a credential or a response body); an unexpected error's message
 * is not, so it is replaced by a fixed sentence and the detail goes to the log.
 */
export function storedFailureMessage(error: unknown): string {
  let text: string;
  if (isBankSyncProviderError(error)) {
    text = error.message;
  } else if (error instanceof HttpException) {
    text = httpExceptionText(error);
  } else {
    text = UNEXPECTED_FAILURE_TEXT;
  }
  return text.slice(0, BANK_SYNC_STORED_MESSAGE_MAX_LENGTH);
}

/** True for the entry of a bank account that was not synced (it carries `error`). */
export function isSyncFailureEntry(
  entry: BankSyncConnectionSyncEntry,
): entry is BankSyncAccountFailure {
  return "error" in entry;
}

/**
 * The failure of one bank account inside a "sync every account" answer: what
 * the HTTP mapping of the same failure would have said, as data.
 *
 * `code` is a stable machine code: the provider's error kind
 * (`session_expired`, `rate_limited`, ...), `credentials` when the stored
 * credentials cannot be used, `sync_running` when another sync of the account
 * holds its lease, `refused` for a refusal Monize made itself (a
 * lease held, a closed account, an inactive connection), and `unexpected` for
 * anything else. `message` is translated and bounded, and is
 * built only from text this code controls or that the provider layer promises
 * is safe (`mapBankSyncProviderError`, an `HttpException`'s message): an
 * unexpected error's own message never reaches a client.
 */
export interface BankSyncFailureDescription {
  code: string;
  message: string;
}

/**
 * The entry for a linked bank account that was not synced because it still
 * needs its preview confirmed (spec section 7a): nothing was read or written,
 * and nothing is recorded on the bank account. The client words its own
 * sentence for the code; the message is the server's fallback.
 */
export function needsPreviewFailure(bankAccountId: string): {
  bankAccountId: string;
  error: BankSyncFailureDescription;
} {
  return {
    bankAccountId,
    error: {
      code: NEEDS_PREVIEW_CODE,
      message: tr(
        "errors.bankSync.needsPreview",
        "Open the preview for this bank account and confirm the first import before it is synced automatically.",
      ),
    },
  };
}

export function describeFailureForClient(
  error: unknown,
): BankSyncFailureDescription {
  if (isBankSyncProviderError(error)) {
    return {
      code: error.kind,
      message: httpExceptionText(mapBankSyncProviderError(error)).slice(
        0,
        BANK_SYNC_STORED_MESSAGE_MAX_LENGTH,
      ),
    };
  }
  if (error instanceof BankSyncAlreadyRunningException) {
    return {
      code: SYNC_RUNNING_CODE,
      message: httpExceptionText(error).slice(
        0,
        BANK_SYNC_STORED_MESSAGE_MAX_LENGTH,
      ),
    };
  }
  if (error instanceof BankSyncCredentialsUnavailableException) {
    return {
      code: "credentials",
      message: httpExceptionText(error).slice(
        0,
        BANK_SYNC_STORED_MESSAGE_MAX_LENGTH,
      ),
    };
  }
  if (error instanceof HttpException) {
    return {
      code: "refused",
      message: httpExceptionText(error).slice(
        0,
        BANK_SYNC_STORED_MESSAGE_MAX_LENGTH,
      ),
    };
  }
  return {
    code: "unexpected",
    message: tr("errors.bankSync.syncUnexpected", UNEXPECTED_FAILURE_TEXT),
  };
}

/** A bounded, secret-free line for the log. */
export function describeSyncFailure(error: unknown): string {
  if (isBankSyncProviderError(error)) {
    return `${error.kind}${error.status === null ? "" : ` (HTTP ${error.status})`}: ${error.message}`;
  }
  if (error instanceof HttpException) {
    return `${error.getStatus()}: ${storedFailureMessage(error)}`;
  }
  return describeFetchFailure(error);
}

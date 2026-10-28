import { reportingFailure } from "../../accruals/reporting-errors";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { tr } from "../../i18n/translate";
import { getRlsMode } from "../db/rls-config";

/**
 * The status and body a request that threw `exception` is answered with.
 *
 * Written once because two places answer for a failure: `GlobalExceptionFilter`
 * for a whole request, and `POST /transactions/bulk` for each row it reports
 * without failing the request. A bulk row promises the answer its single-row
 * route would have given, which only holds while both read this mapping.
 */
export interface HttpErrorBody {
  reporting?: Record<string, unknown>;
  statusCode: number;
  message: string | string[];
  /**
   * Machine-readable code forwarded from an HttpException's object response
   * (e.g. "CURRENCY_INACTIVE"), so a client can branch on the failure without
   * parsing the localized message.
   */
  errorCode?: string;
  /**
   * Structured list (e.g. transaction rules: `{ path, code }` per problem) so a
   * client can point at the offending field.
   */
  errors?: unknown[];
  /**
   * The number a refused bulk command found instead of the one it was told
   * (`POST /email-receipts/bulk`, 409), so the client can ask again with it.
   */
  currentCount?: number;
}

/**
 * True for the two Postgres errors RLS produces that must be mapped to a
 * generic 403 instead of surfacing raw: a WITH CHECK policy violation
 * (SQLSTATE 42501, "new row violates row-level security policy") and the
 * identity-GUC uuid cast on a non-UUID value (SQLSTATE 22P02, "invalid input
 * syntax for type uuid"). Returns false at `RLS_MODE=off`, where neither can
 * occur, so `off` behavior is unchanged and a stray non-RLS 22P02 keeps its
 * existing 500 mapping.
 */
function isRlsViolation(driverError: {
  code?: string;
  message?: string;
}): boolean {
  if (getRlsMode() === "off") {
    return false;
  }
  const dbMessage = (driverError?.message ?? "").toLowerCase();
  return (
    (driverError?.code === "42501" &&
      dbMessage.includes("row-level security")) ||
    (driverError?.code === "22P02" &&
      dbMessage.includes("invalid input syntax for type uuid"))
  );
}

/**
 * Map `exception` to the answer a client receives, logging what is not a
 * client error on `logger`. Database and unexpected errors are reported
 * without their detail.
 */
export function httpErrorBody(
  exception: unknown,
  logger: Logger,
): HttpErrorBody {
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    if (statusCode === HttpStatus.TOO_MANY_REQUESTS) {
      return {
        statusCode,
        message: tr(
          "errors.http.tooManyRequests",
          "Too many requests. Please wait a few minutes and try again.",
        ),
      };
    }
    const exceptionResponse = exception.getResponse();
    if (typeof exceptionResponse === "string") {
      return { statusCode, message: exceptionResponse };
    }
    if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
      const resp = exceptionResponse as Record<string, unknown>;
      const reporting = reportingFailure(exception);
      return {
        statusCode,
        ...(reporting ? { errorCode: String(reporting.code), reporting } : {}),
        message: (resp.message as string | string[]) || exception.message,
        ...(typeof resp.errorCode === "string"
          ? { errorCode: resp.errorCode }
          : {}),
        ...(Array.isArray(resp.errors) ? { errors: resp.errors } : {}),
        ...(typeof resp.currentCount === "number"
          ? { currentCount: resp.currentCount }
          : {}),
      };
    }
    return { statusCode, message: exception.message };
  }

  if (exception instanceof QueryFailedError) {
    const driverError = exception.driverError as {
      code?: string;
      message?: string;
    };
    logger.error("Database error", exception.stack);
    if (driverError?.code === "23505") {
      return {
        statusCode: HttpStatus.CONFLICT,
        message: tr(
          "errors.http.duplicateRecord",
          "A record with this value already exists",
        ),
      };
    }
    if (driverError?.code === "23503") {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: tr(
          "errors.http.referencedRecord",
          "Referenced record does not exist or cannot be removed",
        ),
      };
    }
    if (isRlsViolation(driverError)) {
      // Row-Level Security fail-closed paths -- a WITH CHECK policy violation
      // (42501) or the identity-GUC uuid cast on a malformed value (22P02).
      // These must never surface raw to users; app-level filtering normally
      // prevents reaching them at all. Gated on RLS_MODE so behavior at `off`
      // (no policies, no GUCs) is byte-for-byte unchanged. See design Phase 6.
      return {
        statusCode: HttpStatus.FORBIDDEN,
        message: tr("errors.http.forbidden", "Access denied"),
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: tr("errors.http.internal", "Internal server error"),
    };
  }

  logger.error(
    "Unhandled exception",
    exception instanceof Error ? exception.stack : String(exception),
  );
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    message: tr("errors.http.internal", "Internal server error"),
  };
}

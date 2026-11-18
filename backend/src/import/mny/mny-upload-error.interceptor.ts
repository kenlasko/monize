import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import { Observable, catchError, throwError } from "rxjs";
import { tr } from "../../i18n/translate";

/**
 * The one localized "file too large" error. Shared by the interceptor below and
 * by the handler's own bound check, so a user sees the same sentence whichever
 * of the two rejects the upload.
 */
export function mnyFileTooLargeException(
  limitMb: number,
): PayloadTooLargeException {
  return new PayloadTooLargeException({
    message: tr(
      "errors.import.mnyFileTooLarge",
      // Interpolated in the fallback too: outside a request context `tr`
      // returns it verbatim, and a raw `{{ limit }}` is not something to show
      // a user.
      `That Money file is larger than the ${limitMb} MB import limit.`,
      { limit: limitMb },
    ),
    errorCode: "mnyFileTooLarge",
  });
}

/**
 * Replaces multer's untranslated size error with a localized one that names the
 * limit.
 *
 * Nest maps multer's `LIMIT_FILE_SIZE` to a `PayloadTooLargeException` carrying
 * the literal English "File too large", which is the one failure a user hitting
 * the limit will actually see. Registered **before** the `FileInterceptor` so it
 * sits outside it and can observe the error the inner interceptor throws.
 */
@Injectable()
export class MnyUploadErrorInterceptor implements NestInterceptor {
  constructor(
    private readonly limitMb: number,
    private readonly factory: (
      limitMb: number,
    ) => PayloadTooLargeException = mnyFileTooLargeException,
  ) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof PayloadTooLargeException
              ? this.factory(this.limitMb)
              : error,
          ),
        ),
      );
  }
}

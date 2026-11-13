/**
 * Reading a thrown value without `instanceof Error`: an error raised by Node
 * itself (a failed spawn, a failed fetch) can come from another realm, as it
 * does under jest, and is then not an instance of this realm's `Error`.
 */

function isErrorLike(value: unknown): value is NodeJS.ErrnoException {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export function messageOf(error: unknown): string {
  return isErrorLike(error) ? error.message : String(error);
}

/** The thrown value itself when it is an error, else an `Error` describing it. */
export function asError(error: unknown): NodeJS.ErrnoException {
  return isErrorLike(error) ? error : new Error(String(error));
}

/** The system error code (`ECONNREFUSED`, `ENOENT`) on the value or its cause. */
export function codeOf(error: unknown): string | null {
  for (const candidate of [
    error,
    (error as { cause?: unknown } | null)?.cause,
  ]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return null;
}

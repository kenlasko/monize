/**
 * The values a bond error names, as strings: the controller interpolates them
 * into the translated `errors.bonds.<code>` message. Never a sentence.
 */
export type BondErrorParams = Readonly<Record<string, string>>;

export type BondDataNotFoundCode =
  | "INSTRUMENT_NOT_FOUND"
  | "INSTRUMENT_ID_NOT_FOUND"
  | "PROGRAM_NOT_FOUND"
  | "TERMS_NOT_FOUND"
  | "TERMS_VERSION_NOT_FOUND";

export type BondDataInconsistentCode =
  | "TERMS_MISMATCH"
  /** The stored series is in a unit the rule reading it cannot use (a rate rule on an index level, or the reverse). */
  | "BENCHMARK_UNIT_MISMATCH";

/**
 * The stored data needed to value a lot is not there. `code` and `params` are
 * what a client is told (translated by the controller); `message` is English
 * for the logs only and must never reach a user.
 */
export class BondDataNotFoundError extends Error {
  constructor(
    readonly code: BondDataNotFoundCode,
    readonly params: BondErrorParams,
    message: string,
  ) {
    super(message);
    this.name = "BondDataNotFoundError";
  }
}

/**
 * Stored rows contradict each other; refuse rather than value them. Same
 * contract as {@link BondDataNotFoundError}: `message` is for the logs only.
 */
export class BondDataInconsistentError extends Error {
  constructor(
    readonly code: BondDataInconsistentCode,
    readonly params: BondErrorParams,
    message: string,
  ) {
    super(message);
    this.name = "BondDataInconsistentError";
  }
}

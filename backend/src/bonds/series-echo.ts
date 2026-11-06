/**
 * A value of an official source echoed in a refusal's `params` (INV-BOND-006):
 * a short, grammar-checked machine value, never the source's free text. A value
 * outside the grammar, or longer than `ECHO_MAX_LENGTH`, is `"?"`. Written once
 * for every adapter: the refusal carries a field name and this echo, so a hostile
 * page or file cannot put a script, a sentence or a megabyte into an error.
 */
export const ECHO_MAX_LENGTH = 16;

/** Digits and number punctuation: a rate, a price, a percentage, a date. */
export const NUMERIC_ECHO = /^[0-9.,%/:-]{1,16}$/;

/** Letters and digits as well, and empty (an absent value): a code, a flag, a type, a bound. */
export const TEXT_ECHO = /^[A-Za-z0-9.,%/:<>-]{0,16}$/;

export function echo(value: unknown, grammar: RegExp = NUMERIC_ECHO): string {
  return typeof value === "string" && grammar.test(value) ? value : "?";
}

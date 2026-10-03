import type { EmailReceiptParserStatus } from "../entities/email-receipt-parser.entity";

/** The fields of a parser that decide whether it reads a given email. */
export interface SelectableReceiptParser {
  id: string;
  status: EmailReceiptParserStatus;
  fromDomains: readonly string[];
  subjectContains: readonly string[];
  createdAt: Date;
}

const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/\.+$/, "");

/**
 * How well one parser domain fits the sender: its length when the sender's domain
 * equals it or is a sub-domain of it (ends with "." + domain, so `mail.shop.com`
 * is `shop.com`'s but `notshop.com` is not), else -1. A longer match is a more
 * specific one.
 */
function domainSpecificity(senderDomain: string, parserDomain: string): number {
  const domain = normalizeDomain(parserDomain);
  if (domain === "") return -1;
  return senderDomain === domain || senderDomain.endsWith(`.${domain}`)
    ? domain.length
    : -1;
}

/** No subject words: every subject fits. Otherwise at least one word must occur in it. */
function subjectFits(
  subject: string,
  subjectContains: readonly string[],
): boolean {
  const words = subjectContains
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = subject.toLowerCase();
  return words.some((word) => haystack.includes(word));
}

/**
 * The approved parser that reads an email from `fromDomain` with `subject`, or
 * null (design section 6; spec "no parser" branch).
 *
 * A draft never reads mail. The sender's domain must equal one of the parser's
 * domains or end with "." + that domain; the parser whose best-matching domain
 * is the longest wins, so `orders.shop.com` beats `shop.com`; the subject words
 * (all lower-case substrings) must include at least one when there are any; a
 * tie on specificity goes to the older parser, then the lower id, so the choice
 * never depends on the order rows were read in.
 */
export function selectReceiptParser<T extends SelectableReceiptParser>(
  parsers: readonly T[],
  fromDomain: string,
  subject: string,
): T | null {
  const sender = normalizeDomain(fromDomain);
  if (sender === "") return null;
  let best: { parser: T; specificity: number } | null = null;
  for (const parser of parsers) {
    if (parser.status !== "approved") continue;
    if (!subjectFits(subject, parser.subjectContains)) continue;
    const specificity = Math.max(
      -1,
      ...parser.fromDomains.map((domain) => domainSpecificity(sender, domain)),
    );
    if (specificity < 0) continue;
    if (best === null || beats(parser, specificity, best)) {
      best = { parser, specificity };
    }
  }
  return best === null ? null : best.parser;
}

function beats<T extends SelectableReceiptParser>(
  parser: T,
  specificity: number,
  best: { parser: T; specificity: number },
): boolean {
  if (specificity !== best.specificity) return specificity > best.specificity;
  const byAge = parser.createdAt.getTime() - best.parser.createdAt.getTime();
  if (byAge !== 0) return byAge < 0;
  return parser.id < best.parser.id;
}

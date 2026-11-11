import { splitDomains, splitWords } from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS } from '@/types/email-receipts';

/** The profile fields Save checks before it asks the server, in the order they appear on the dialog. */
export const PROFILE_FIELDS = ['name', 'fromDomains', 'subjectContains', 'definition'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type ProfileFieldProblem =
  | { field: 'name'; code: 'missing' }
  | { field: 'fromDomains'; code: 'missing' }
  | { field: 'fromDomains'; code: 'too_many' }
  | { field: 'fromDomains'; code: 'invalid'; values: string[] }
  | { field: 'subjectContains'; code: 'too_many' }
  | { field: 'subjectContains'; code: 'too_long' }
  | { field: 'definition'; code: 'json_invalid' }
  /** The server refused the field (a DTO refusal naming it); the message itself is shown beside the Save button. */
  | { field: ProfileField; code: 'server' };

/**
 * A sender domain as the server stores it (`normalizeReceiptDomain` in
 * `backend/src/email-receipts/parsers/dto/receipt-domain.validator.ts`):
 * lower-case, no trailing dot. `splitDomains` has already dropped any `@` part.
 */
const storedDomain = (domain: string): string => domain.toLowerCase().replace(/\.+$/, '');

/** The server's `isReceiptDomain`, mirrored so Save can say which entry is wrong before it asks. The server stays the authority. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_DOMAIN_LENGTH = 253;

export function isValidReceiptDomain(domain: string): boolean {
  const stored = storedDomain(domain);
  return stored.length <= MAX_DOMAIN_LENGTH && HOSTNAME.test(stored);
}

export interface ProfileCheckInput {
  name: string;
  fromDomains: string;
  subjectContains: string;
  /** The JSON box is in use and does not parse into a definition. */
  jsonInvalid: boolean;
}

/**
 * What the dialog can tell is wrong or missing before Save sends anything, in
 * the order the fields appear, so the first one is where the dialog scrolls to.
 * Each field reports at most one problem: the one to fix first.
 */
export function checkProfileFields(input: ProfileCheckInput): ProfileFieldProblem[] {
  const problems: ProfileFieldProblem[] = [];
  if (input.name.trim() === '') problems.push({ field: 'name', code: 'missing' });

  const domains = splitDomains(input.fromDomains);
  const invalid = domains.filter((domain) => !isValidReceiptDomain(domain));
  if (domains.length === 0) problems.push({ field: 'fromDomains', code: 'missing' });
  else if (invalid.length > 0) problems.push({ field: 'fromDomains', code: 'invalid', values: invalid });
  else if (domains.length > RECEIPT_PARSER_LIMITS.maxFromDomains) problems.push({ field: 'fromDomains', code: 'too_many' });

  const words = splitWords(input.subjectContains);
  if (words.length > RECEIPT_PARSER_LIMITS.maxSubjectWords) problems.push({ field: 'subjectContains', code: 'too_many' });
  else if (words.some((word) => word.length > RECEIPT_PARSER_LIMITS.maxSubjectWordLength)) {
    problems.push({ field: 'subjectContains', code: 'too_long' });
  }

  if (input.jsonInvalid) problems.push({ field: 'definition', code: 'json_invalid' });
  return problems;
}

/** The request's property names, as a DTO refusal writes them, for each field the dialog shows. */
const DTO_PROPERTIES: Readonly<Record<string, ProfileField>> = {
  name: 'name',
  fromDomains: 'fromDomains',
  subjectContains: 'subjectContains',
  definition: 'definition',
};

/**
 * The fields a DTO refusal names. The validation pipe writes each sentence as
 * `<property> must ...` or `each value of <property> must ...`, and
 * `getErrorMessage` joins them with `. `, so a property is read only at the
 * start of a sentence: a definition problem such as `items.single.name: empty`
 * is not the profile's name.
 */
export function serverFieldProblems(message: string): ProfileFieldProblem[] {
  const fields = new Set<ProfileField>();
  for (const match of message.matchAll(/(?:^|\.\s+)(?:each value of\s+)?([A-Za-z]+)\s+(?:must|should)\b/g)) {
    const field = DTO_PROPERTIES[match[1]];
    if (field !== undefined) fields.add(field);
  }
  return PROFILE_FIELDS.filter((field) => fields.has(field)).map((field) => ({ field, code: 'server' as const }));
}

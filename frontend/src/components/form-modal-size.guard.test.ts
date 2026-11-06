import { describe, it, expect } from 'vitest';

/**
 * Guard for `docs/frontend/screens-and-dialogs.md`'s rule that a form dialog has
 * one size wherever it opens. The Payee and Category detail tabs opened Edit
 * Transaction at `2xl` while the Transactions page used `6xl`, and the investment
 * form's New Security opened at `lg` while the Securities page used `3xl`: the
 * same form, laid out for one width, wrapping its fields in a narrower one.
 *
 * Each form's size is written once, in a props object its hosts spread onto
 * `Modal`. For every `<Form` a production source renders, the nearest `<Modal`
 * opening tag before it must spread that object and must not name `maxWidth` or
 * `className` of its own (either would override or fight the shared size).
 */
const sources = import.meta.glob('/src/**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

const FORMS = [
  { form: 'TransactionForm', spread: '{...transactionModalProps}' },
  { form: 'InvestmentTransactionForm', spread: '{...investmentTransactionModalProps(' },
  { form: 'SecurityForm', spread: '{...securityFormModalProps}' },
] as const;

/** The `<Modal ...>` opening tag that starts at `start`, braces balanced so an
 *  arrow function's `=>` inside an attribute does not end it early. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe('a form dialog has one size wherever it opens', () => {
  for (const { form, spread } of FORMS) {
    it(`every Modal hosting <${form}> spreads ${spread.replace(/[{}(]/g, '')}`, () => {
      const tagPattern = new RegExp(`<${form}\\b`, 'g');
      const offenders: string[] = [];
      let hosts = 0;
      for (const [path, content] of Object.entries(sources)) {
        if (/\.test\.tsx$/.test(path)) continue;
        for (const match of content.matchAll(tagPattern)) {
          hosts += 1;
          const modalStart = content.lastIndexOf('<Modal', match.index);
          const line = content.slice(0, match.index).split('\n').length;
          if (modalStart < 0) {
            offenders.push(`${path}:${line} renders <${form}> outside a Modal`);
            continue;
          }
          const tag = openingTag(content, modalStart);
          if (!tag.includes(spread)) {
            offenders.push(`${path}:${line} does not spread ${spread}`);
          } else if (/\s(maxWidth|className)=/.test(tag)) {
            offenders.push(`${path}:${line} sets its own maxWidth or className`);
          }
        }
      }
      expect(hosts).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    });
  }
});

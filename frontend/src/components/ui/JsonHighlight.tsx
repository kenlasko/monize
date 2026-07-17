'use client';

import { ReactNode } from 'react';

interface JsonHighlightProps {
  value: unknown;
  className?: string;
}

// Matches, in order: a string (optionally a key when followed by a colon),
// true/false/null, or a number. Everything between matches is punctuation.
const TOKEN_REGEX =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Pretty-prints a value as indented JSON with lightweight syntax colouring
 * (keys, strings, numbers, literals), dependency-free so it stays CSP-safe.
 * Colours follow the theme via Tailwind dark variants.
 */
export function JsonHighlight({ value, className = '' }: JsonHighlightProps) {
  const json = JSON.stringify(value, null, 2) ?? 'null';
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const match of json.matchAll(TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push(json.slice(cursor, index));
    }
    const [full, str, colon, literal] = match;
    if (str !== undefined) {
      const isKey = colon !== undefined;
      parts.push(
        <span
          key={key++}
          className={
            isKey
              ? 'text-sky-700 dark:text-sky-300'
              : 'text-emerald-700 dark:text-emerald-300'
          }
        >
          {str}
        </span>,
      );
      if (isKey) parts.push(colon);
    } else if (literal !== undefined) {
      parts.push(
        <span key={key++} className="text-purple-700 dark:text-purple-300">
          {literal}
        </span>,
      );
    } else {
      parts.push(
        <span key={key++} className="text-amber-700 dark:text-amber-300">
          {full}
        </span>,
      );
    }
    cursor = index + full.length;
  }
  if (cursor < json.length) {
    parts.push(json.slice(cursor));
  }

  return (
    <pre
      className={`whitespace-pre-wrap break-all font-mono text-xs text-gray-600 dark:text-gray-300 ${className}`}
    >
      {parts}
    </pre>
  );
}

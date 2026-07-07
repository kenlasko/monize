/**
 * Language directives for the AI natural-language surfaces (insights, forecast,
 * and the query assistant). The data-driven generators (insights and forecast)
 * are prompted with structured aggregates that carry no natural-language cue,
 * so without an explicit instruction the model always answers in English. This
 * maps the user's stored language preference (`user_preferences.language`) to a
 * directive appended to the system prompt so generated prose matches the
 * language the user picked in Settings.
 *
 * English display names -- not native names -- give the model the clearest,
 * most reliable target. Regional English variants (and the dev-only pseudo
 * locale) need no directive because the base prompts are already English.
 */

const AI_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  de: "German",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  "pt-BR": "Brazilian Portuguese",
  ru: "Russian",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
};

/**
 * The English name of the language the model should write in, or null when the
 * preference resolves to English (en, its regional variants, the pseudo-locale,
 * or an unknown code) and no directive is needed.
 */
export function aiLanguageName(
  language: string | undefined | null,
): string | null {
  if (!language) return null;
  return AI_LANGUAGE_NAMES[language] ?? null;
}

/**
 * A system-prompt directive telling the model to produce its user-facing prose
 * in the user's language while leaving structure, enum values, currency codes,
 * numbers, and proper nouns from the user's data untranslated. Returns an empty
 * string for English (or any locale without a mapped name) so callers can
 * concatenate unconditionally: `SYSTEM_PROMPT + aiLanguageInstruction(lang)`.
 */
export function aiLanguageInstruction(
  language: string | undefined | null,
): string {
  const name = aiLanguageName(language);
  if (!name) return "";

  return `

LANGUAGE:
Write every piece of user-facing prose you produce -- titles, descriptions, narrative summaries, and any explanations -- in ${name}. Do NOT translate or transliterate: JSON field names, enum values (such as type and severity), currency codes, numeric values, dates, or proper nouns copied from the user's data (account, category, payee, and security names). Reproduce those exactly as given. Keep the required output format and structure unchanged.`;
}

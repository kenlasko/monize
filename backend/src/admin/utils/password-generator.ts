import * as crypto from "crypto";

const WORDS = [
  "Tiger",
  "River",
  "Stone",
  "Cloud",
  "Brave",
  "Swift",
  "Storm",
  "Flame",
  "Ocean",
  "Eagle",
  "Cedar",
  "Steel",
  "Light",
  "Frost",
  "Haven",
  "Crown",
  "Drift",
  "Blaze",
  "Grove",
  "Pearl",
  "Amber",
  "Lunar",
  "Coral",
  "Maple",
  "Raven",
  "Sage",
  "Crest",
  "Dusk",
  "Fern",
  "Glen",
  "Haze",
  "Jade",
  "Lake",
  "Mesa",
  "Nova",
  "Opal",
  "Pine",
  "Reed",
  "Silk",
  "Vale",
];

const SPECIAL_CHARS = ["@", "$", "!", "%", "*", "?", "&"];

/**
 * Generates a human-friendly password that satisfies complexity requirements:
 * uppercase, lowercase, digit, and special character (@$!%*?&).
 * Pattern: Word + special + Word + 2-digit number (e.g., "Tiger!River42")
 */
export function generateReadablePassword(): string {
  const word1 = WORDS[crypto.randomInt(WORDS.length)];
  const word2 = WORDS[crypto.randomInt(WORDS.length)];
  const special = SPECIAL_CHARS[crypto.randomInt(SPECIAL_CHARS.length)];
  const digits = crypto.randomInt(10, 99).toString();
  return `${word1}${special}${word2}${digits}`;
}

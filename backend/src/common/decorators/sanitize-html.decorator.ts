import { Transform } from "class-transformer";

/**
 * Strips HTML angle brackets from string values to prevent stored XSS.
 * Also rejects non-string values (objects, arrays) that would otherwise
 * be coerced to "[object Object]" by enableImplicitConversion.
 */
export function SanitizeHtml(): PropertyDecorator {
  return Transform(({ obj, key }) => {
    const raw = obj[key];
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== "string") return raw;
    return raw.replace(/[<>]/g, "");
  });
}

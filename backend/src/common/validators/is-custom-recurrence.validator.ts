import { ValidateBy, ValidationArguments } from "class-validator";
import { normalizeCustomRecurrence } from "../custom-recurrence";

/**
 * Validates a Custom frequency's rule through `normalizeCustomRecurrence`, the
 * function the stepper calls, so a rule the API accepts is one the schedule can
 * walk (docs/specs/custom-recurrence.md section 2).
 *
 * The rule is a plain object, not a nested DTO: `whitelist` and
 * `forbidNonWhitelisted` never look inside it, so this validator is what keeps
 * its shape bounded. The normalizer refuses a key outside the unit's own
 * fields and caps every array (7 weekdays, 32 month days, 366 dates), so no
 * arbitrary JSON reaches the `custom_recurrence` column. Pair with
 * `@IsOptional()`; the service stores the canonical form, never the request's.
 */
export function IsCustomRecurrence(): PropertyDecorator {
  return ValidateBy({
    name: "isCustomRecurrence",
    validator: {
      validate: (value: unknown): boolean =>
        normalizeCustomRecurrence(value).ok,
      defaultMessage: (args?: ValidationArguments): string => {
        const result = normalizeCustomRecurrence(args?.value);
        const reason = result.ok ? "" : ` (${result.error})`;
        return `$property must be a valid custom recurrence rule${reason}`;
      },
    },
  });
}

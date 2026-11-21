import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  registerDecorator,
  ValidationOptions,
} from "class-validator";

/**
 * A value `Intl` can build a number formatter from, or the `browser` sentinel.
 *
 * `@IsString() @MaxLength(n)` is a shape check, not a locale check: it accepts
 * `en_US` -- the underscore form half the world writes -- which
 * `Intl.NumberFormat` rejects with `RangeError`. Stored, that value reached
 * every formatter at once: the Monthly Comparison report answered 500, and the
 * cron composing bill reminders and budget alerts threw, so those emails stopped
 * with no message anywhere saying why (issue #1316 review).
 *
 * The formatters defend themselves too (`common/number-locale.util.ts` and the
 * client's `useNumberFormat`, both falling back rather than throwing), because
 * rows written before this validator existed are not going to revalidate
 * themselves. This stops new ones.
 */
export function isNumberLocale(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "browser") return true;
  try {
    new Intl.NumberFormat(value);
    return true;
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: "isNumberLocale", async: false })
export class IsNumberLocaleConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean {
    return isNumberLocale(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be "browser" or a BCP 47 locale tag (e.g. "en-US", not "en_US")`;
  }
}

export function IsNumberLocale(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsNumberLocaleConstraint,
    });
  };
}

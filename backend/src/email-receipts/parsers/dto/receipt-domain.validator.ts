import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";

/** A sender domain as stored: a dotted host name, lower-case, no `@`, no port. */
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_DOMAIN_LENGTH = 253;

/**
 * What a person typed for a sender domain, as stored: trimmed, lower-case, a
 * leading `@` (from pasting an address's domain part) and a trailing dot
 * removed. A value that is not a string is returned unchanged for the
 * validator to refuse.
 */
export function normalizeReceiptDomain(raw: unknown): unknown {
  return typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "")
    : raw;
}

/** The length is checked before the pattern, so a hostile value costs one comparison. */
export function isReceiptDomain(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= MAX_DOMAIN_LENGTH &&
    HOSTNAME.test(value)
  );
}

export function IsReceiptDomain(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      name: "isReceiptDomain",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isReceiptDomain(value),
        defaultMessage: (args: ValidationArguments) =>
          `each value of ${args.property} must be a host name such as shop.example.com`,
      },
    });
  };
}

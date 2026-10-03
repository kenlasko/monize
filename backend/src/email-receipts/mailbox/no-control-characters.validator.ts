import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator";
import { isSendableApiKey } from "../../payees/lookup/google-places/google-places-key";

/**
 * A text field that reaches an IMAP command (the user name, the folder) must
 * hold no control character: they are what a protocol line is broken with.
 * The rule is the one `isSendableApiKey` already is for a header value -- C0
 * controls and DEL, nothing else -- so this asks the same function rather than
 * spelling a second character class.
 */
export function IsNoControlCharacters(options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      name: "isNoControlCharacters",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          typeof value === "string" && isSendableApiKey(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must not contain control characters`,
      },
    });
  };
}

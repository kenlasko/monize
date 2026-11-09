import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { VIEW_DEFAULT_FIELDS, isViewDefaultKey } from "../view-defaults";

function isAllowedList(
  field: { list: readonly string[]; max: number },
  value: unknown,
): boolean {
  if (!Array.isArray(value) || value.length > field.max) return false;
  return (
    value.every((item) => (field.list as readonly unknown[]).includes(item)) &&
    new Set(value).size === value.length
  );
}

// Each key must be a declared view default holding one of its declared values.
// Anything else is refused, never dropped, so a client that sends a setting the
// server does not know learns of it. Requiring every key to be declared also
// excludes `__proto__`, `constructor` and `prototype`, and bounds the object
// to the declared keys.
function isAllowedValue(
  allowed: (typeof VIEW_DEFAULT_FIELDS)[keyof typeof VIEW_DEFAULT_FIELDS],
  value: unknown,
): boolean {
  if (allowed === "boolean") return typeof value === "boolean";
  if ("list" in allowed) return isAllowedList(allowed, value);
  return (allowed as readonly unknown[]).includes(value);
}

@ValidatorConstraint({ async: false })
export class IsViewDefaultsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;

    const map = value as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (!isViewDefaultKey(key)) return false;
      if (!isAllowedValue(VIEW_DEFAULT_FIELDS[key], map[key])) return false;
    }

    return true;
  }

  defaultMessage(): string {
    return "viewDefaults must be an object whose keys are density (normal, compact or dense), hideRegisterYear, widgetsCollapsed, chartCollapsed (booleans), accountOpenTarget (register or dashboard) and mobileTabs (up to three distinct tab names)";
  }
}

export function IsViewDefaults(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsViewDefaultsConstraint,
    });
  };
}

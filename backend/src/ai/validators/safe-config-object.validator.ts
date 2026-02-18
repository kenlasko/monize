import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_KEYS = 20;

@ValidatorConstraint({ async: false })
export class IsSafeConfigObjectConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length > MAX_KEYS) return false;

    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) return false;

      const val = obj[key];
      if (val === null || val === undefined) continue;

      const type = typeof val;
      if (type !== "string" && type !== "number" && type !== "boolean") {
        return false;
      }

      if (type === "string" && (val as string).length > 1000) {
        return false;
      }
    }

    return true;
  }

  defaultMessage(): string {
    return "config must be a flat object with string, number, or boolean values only (max 20 keys)";
  }
}

export function IsSafeConfigObject(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsSafeConfigObjectConstraint,
    });
  };
}

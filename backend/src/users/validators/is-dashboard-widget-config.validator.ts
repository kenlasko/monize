import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// The map is keyed by widget id; each value is that widget's flat settings
// object. Bounds keep an arbitrary client payload from bloating the row.
const MAX_WIDGETS = 50;
const MAX_KEYS_PER_WIDGET = 20;
const MAX_ARRAY_LENGTH = 200;
const MAX_STRING_LENGTH = 100;
const WIDGET_ID_PATTERN = /^[a-z0-9-]+$/;

function isFlatSettings(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;

  const settings = value as Record<string, unknown>;
  const keys = Object.keys(settings);
  if (keys.length > MAX_KEYS_PER_WIDGET) return false;

  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) return false;
    if (key.length > MAX_STRING_LENGTH) return false;

    const val = settings[key];
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      if (val.length > MAX_ARRAY_LENGTH) return false;
      for (const item of val) {
        const itemType = typeof item;
        if (
          itemType !== "string" &&
          itemType !== "number" &&
          itemType !== "boolean"
        ) {
          return false;
        }
        if (
          itemType === "string" &&
          (item as string).length > MAX_STRING_LENGTH
        ) {
          return false;
        }
      }
      continue;
    }

    const type = typeof val;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      return false;
    }
    if (type === "string" && (val as string).length > MAX_STRING_LENGTH) {
      return false;
    }
  }

  return true;
}

@ValidatorConstraint({ async: false })
export class IsDashboardWidgetConfigConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;

    const map = value as Record<string, unknown>;
    const widgetIds = Object.keys(map);
    if (widgetIds.length > MAX_WIDGETS) return false;

    for (const widgetId of widgetIds) {
      if (DANGEROUS_KEYS.has(widgetId)) return false;
      if (!WIDGET_ID_PATTERN.test(widgetId)) return false;
      if (widgetId.length > MAX_STRING_LENGTH) return false;
      if (!isFlatSettings(map[widgetId])) return false;
    }

    return true;
  }

  defaultMessage(): string {
    return "dashboardWidgetConfig must be an object keyed by widget id, each value a flat settings object of primitives or arrays of primitives";
  }
}

export function IsDashboardWidgetConfig(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      constraints: [],
      validator: IsDashboardWidgetConfigConstraint,
    });
  };
}

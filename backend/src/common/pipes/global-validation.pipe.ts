import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";

/**
 * Nest's `ValidationPipe` converts a named `@Query()` or `@Param()` declared
 * `number` to `+value` and one declared `boolean` to `value === "true"` before
 * any parameter pipe runs, so `ParseIntPipe` read `?limit=0x10` as 16 and
 * `?limit=` as 0 (which `DefaultValuePipe` never replaces), and `ParseBoolPipe`
 * read `?includeInactive=yes` as false (issue 2225). This one hands such a
 * parameter the request's own value instead, and an empty one as absent (as
 * `ParseOptionalCalendarDatePipe` reads it), so the parameter's Nest pipe
 * checks the text: `ParseIntPipe` refuses anything but optionally signed
 * digits, `ParseBoolPipe` anything but `true` and `false`, and a repeated key
 * (an array) is refused by both. Every such parameter therefore carries one of
 * them (`global-validation-param-pipes.guard.spec.ts`); a `string` parameter is
 * still converted to `String(value)`.
 */
class GlobalValidationPipe extends ValidationPipe {
  protected override transformPrimitive(
    value: unknown,
    metadata: ArgumentMetadata,
  ): unknown {
    const { type, metatype, data } = metadata;
    if (
      data &&
      (type === "query" || type === "param") &&
      (metatype === Number || metatype === Boolean)
    ) {
      return value === "" ? undefined : value;
    }
    return super.transformPrimitive(value, metadata);
  }
}

/**
 * The `ValidationPipe` `main.ts` registers for every route, built here so a spec
 * that drives a route through the request pipeline runs the same one. It runs
 * before any parameter pipe, and `transform: true` converts a `@Query()` or
 * `@Param()` declared `string` to `String(value)` first; one declared `number`
 * or `boolean` reaches its pipe as sent (`GlobalValidationPipe`,
 * `docs/backend/entities-and-dtos.md`).
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new GlobalValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

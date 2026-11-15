import { ValidationPipe } from "@nestjs/common";

/**
 * The `ValidationPipe` `main.ts` registers for every route, built here so a spec
 * that drives a route through the request pipeline runs the same one. It runs
 * before any parameter pipe, and `transform: true` converts a `@Query()` or
 * `@Param()` declared `number` to `+value`, `boolean` to `value === "true"` and
 * `string` to `String(value)` first (`docs/backend/entities-and-dtos.md`).
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

import { readFileSync } from "fs";
import { join } from "path";
import { VIEW_DEFAULT_FIELDS } from "./view-defaults";

/**
 * The view defaults are ONE map, declared in two layers.
 *
 * Neither disagreement shows up in a type error. A key or value the browser
 * sends and the server does not know is a 400 on every save from Settings, so
 * no default can be stored. One the server accepts and the browser does not
 * know is dropped on read, so it can be stored but never applied or shown.
 * The validator refuses rather than drops, so the browser's map must be a
 * subset; equal, in order, is the claim.
 *
 * The browser's copy cannot import the server's, so it is read as text here.
 */
const repoRoot = join(__dirname, "..", "..", "..");

describe("the view defaults", () => {
  it("are the same keys and values, in the same order, in both layers", () => {
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/view-defaults.ts"),
      "utf8",
    );
    const declaration = frontend.match(
      /VIEW_DEFAULT_FIELDS\s*=\s*\{([\s\S]*?)\}\s*as const/,
    );
    // Jest has no message argument on expect, so the shape this scan needs is
    // stated here instead: the frontend map must stay an `as const` object
    // literal of `key: [quoted values]`, `key: 'boolean'` or
    // `key: { list: [quoted values], max: N }` entries, or this guard stops
    // covering it.
    expect(declaration).not.toBeNull();

    const quoted = (values: string) =>
      [...values.matchAll(/["']([A-Za-z]+)["']/g)].map((v) => v[1]);
    const entries = [
      ...declaration![1].matchAll(
        /([A-Za-z]+)\s*:\s*(?:\{\s*list\s*:\s*\[([\s\S]*?)\]\s*,\s*max\s*:\s*(\d+)\s*,?\s*\}|\[([\s\S]*?)\]|["'](boolean)["'])/g,
      ),
    ].map(([, key, list, max, values, flag]) => [
      key,
      list !== undefined
        ? { list: quoted(list), max: Number(max) }
        : (flag ?? quoted(values)),
    ]);

    expect(entries).toEqual(
      Object.entries(VIEW_DEFAULT_FIELDS).map(([key, allowed]) => [
        key,
        allowed === "boolean"
          ? "boolean"
          : "list" in allowed
            ? { list: [...allowed.list], max: allowed.max }
            : [...allowed],
      ]),
    );
  });
});

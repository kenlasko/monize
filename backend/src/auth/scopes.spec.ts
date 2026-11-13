import * as fs from "fs";
import * as path from "path";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  API_SCOPES,
  MCP_SCOPE_PREFIX,
  apiScopesList,
  apiScopesPattern,
  hasApiScope,
  isApiScope,
} from "./scopes";
import { CreatePatDto } from "./dto/create-pat.dto";
import { MCP_RESOURCE_SCOPES } from "../oauth/oauth-provider.service";
import { hasScope, requireScope } from "../mcp/mcp-context";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function collectFiles(dir: string, extension: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

const scopesOf = async (scopes: string): Promise<string[]> => {
  const dto = plainToInstance(CreatePatDto, { name: "t", scopes });
  const errors = await validate(dto);
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
};

/**
 * The scope vocabulary lived in four places -- the schema comment, the PAT DTO
 * regex, the OAuth resource list, and a feature plan -- and they disagreed: two
 * of them documented a `reports` scope that PAT issuance rejects, so a client
 * following the schema got a validation error for a scope the repository said
 * existed.
 *
 * These are the checks that keep the four agreeing. They enumerate from
 * `API_SCOPES` rather than restating the list, so adding a scope there is what
 * makes them cover it.
 */
describe("API scope vocabulary", () => {
  describe("PAT issuance", () => {
    it.each(API_SCOPES)("accepts %s on its own", async (scope) => {
      expect(await scopesOf(scope)).toEqual([]);
    });

    it("accepts every supported scope at once", async () => {
      expect(await scopesOf(API_SCOPES.join(","))).toEqual([]);
    });

    it("rejects a scope that is not in the vocabulary", async () => {
      // The `reports` case verbatim: documented, never issuable.
      expect(await scopesOf("reports")).not.toEqual([]);
      expect(await scopesOf("read,reports")).not.toEqual([]);
    });

    it("rejects an empty scope list and a trailing separator", async () => {
      expect(await scopesOf("")).not.toEqual([]);
      expect(await scopesOf("read,")).not.toEqual([]);
    });

    it("names every supported scope in the rejection message", async () => {
      const [message] = await scopesOf("nope");
      for (const scope of API_SCOPES) {
        expect(message).toContain(scope);
      }
    });
  });

  describe("guards and tools read the same strings", () => {
    it.each(API_SCOPES)("hasScope recognises %s", (scope) => {
      expect(hasScope(API_SCOPES.join(","), scope)).toBe(true);
      expect(requireScope(API_SCOPES.join(","), scope).error).toBe(false);
    });

    it("refuses a scope the token does not carry", () => {
      expect(requireScope("read", "write").error).toBe(true);
    });

    it("classifies membership consistently with the list", () => {
      for (const scope of API_SCOPES) {
        expect(isApiScope(scope)).toBe(true);
      }
      expect(isApiScope("reports")).toBe(false);
    });
  });

  describe("OAuth advertises exactly the same set, prefixed", () => {
    it("derives the resource scopes from the vocabulary", () => {
      expect([...MCP_RESOURCE_SCOPES]).toEqual(
        API_SCOPES.map((scope) => `${MCP_SCOPE_PREFIX}${scope}`),
      );
    });

    it("advertises no scope a PAT could not also be issued", () => {
      for (const advertised of MCP_RESOURCE_SCOPES) {
        expect(isApiScope(advertised.slice(MCP_SCOPE_PREFIX.length))).toBe(
          true,
        );
      }
    });
  });

  /**
   * Scanning guards, not unit tests: the defect was a *document* naming a scope
   * the code did not have, and no amount of prose keeps that from recurring. Both
   * checks are deliberately narrow -- they read one machine-identifiable
   * construct each, rather than trying to judge prose, so they cannot be
   * satisfied by rewording and cannot fire on a sentence that merely mentions a
   * retired scope by name.
   */
  describe("documentation does not advertise an unissuable scope", () => {
    it("schema.sql enumerates exactly the supported scopes for personal_access_tokens", () => {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "database/schema.sql"),
        "utf8",
      );
      // The trailing comment on the column definition. This is the copy that was
      // wrong -- it listed 'read', 'write', 'reports'.
      const line = /^\s*scopes VARCHAR\(500\).*--(.*)$/m.exec(source);
      expect(line).not.toBeNull();

      const enumerated = [...line![1].matchAll(/'([a-z]+)'/g)].map(
        (match) => match[1],
      );
      expect(enumerated).toEqual([...API_SCOPES]);
    });

    it("no document requires a scope through requireScope that cannot be issued", () => {
      // A plan proposing `requireScope(..., "reports")` describes a tool no PAT
      // client could ever call. The call shape is exact, so this reads it
      // directly instead of guessing at intent.
      const docs = collectFiles(path.join(REPO_ROOT, "docs"), ".md");
      const offenders: string[] = [];

      for (const file of docs) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(
          /requireScope\([^)]*?['"]([a-z:]+)['"]/g,
        )) {
          const scope = match[1].startsWith(MCP_SCOPE_PREFIX)
            ? match[1].slice(MCP_SCOPE_PREFIX.length)
            : match[1];
          if (!isApiScope(scope)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[1]}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe("the PAT UI offers exactly the issuable scopes", () => {
    it("keeps SCOPE_OPTIONS in step with API_SCOPES", () => {
      // A scope the backend accepts but the UI never offers is unreachable for
      // every user who does not hand-craft the request; the reverse is a control
      // that fails validation on submit.
      const source = fs.readFileSync(
        path.join(
          REPO_ROOT,
          "frontend/src/components/settings/ApiAccessSection.tsx",
        ),
        "utf8",
      );
      const block = /const SCOPE_OPTIONS = \[(.*?)\];/s.exec(source);
      expect(block).not.toBeNull();

      const offered = [...block![1].matchAll(/value:\s*['"]([a-z]+)['"]/g)].map(
        (match) => match[1],
      );
      expect(offered).toEqual([...API_SCOPES]);
    });
  });

  it("exposes the list for messages and documentation", () => {
    expect(apiScopesList()).toBe(API_SCOPES.join(", "));
    expect(apiScopesPattern().test(API_SCOPES.join(","))).toBe(true);
  });

  describe("hasApiScope", () => {
    it.each([
      ["read", "read", true],
      ["read,write", "read", true],
      ["read,write", "write", true],
      ["write", "read", false],
      ["read", "write", false],
      ["", "read", false],
      ["readwrite", "read", false],
    ])("scopes %p requires %p: %s", (scopes, required, expected) => {
      expect(hasApiScope(scopes, required)).toBe(expected);
    });
  });
});

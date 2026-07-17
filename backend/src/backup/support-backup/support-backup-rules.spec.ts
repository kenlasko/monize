import {
  ALWAYS_EXCLUDED_TABLES,
  RULES,
  SECTION_FK_CLEANUP,
  SECTION_TABLES,
} from "./support-backup-rules";

/**
 * Drift guards for the hand-maintained section maps. The golden integration
 * test ties RULES to the live schema; these unit checks tie the section
 * machinery to RULES so a new table or column can't silently bypass a
 * section checkbox or point the FK cleanup at nothing.
 */
describe("support backup rules registry", () => {
  it("every sectioned table is classified and owned by exactly one section", () => {
    const seen = new Map<string, string>();
    for (const [section, tables] of Object.entries(SECTION_TABLES)) {
      for (const table of tables) {
        expect(RULES[table]).toBeDefined();
        expect(seen.get(table)).toBeUndefined();
        seen.set(table, section);
      }
    }
  });

  it("every FK-cleanup target exists in the rules registry", () => {
    for (const cleanups of Object.values(SECTION_FK_CLEANUP)) {
      for (const { table, column } of cleanups) {
        expect(RULES[table]).toBeDefined();
        expect(RULES[table][column]).toBeDefined();
      }
    }
  });

  it("always-excluded tables have no rules (they are never emitted)", () => {
    for (const table of ALWAYS_EXCLUDED_TABLES) {
      expect(RULES[table]).toBeUndefined();
    }
  });
});

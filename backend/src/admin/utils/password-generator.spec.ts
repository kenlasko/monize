import { generateReadablePassword } from "./password-generator";

describe("generateReadablePassword", () => {
  it("returns a string", () => {
    const password = generateReadablePassword();
    expect(typeof password).toBe("string");
  });

  it("has minimum length of 10 characters", () => {
    // Shortest possible: 4-char word + 1 special + 4-char word + 2 digits = 11
    for (let i = 0; i < 20; i++) {
      const password = generateReadablePassword();
      expect(password.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("contains at least one uppercase letter", () => {
    for (let i = 0; i < 20; i++) {
      const password = generateReadablePassword();
      expect(password).toMatch(/[A-Z]/);
    }
  });

  it("contains at least one lowercase letter", () => {
    for (let i = 0; i < 20; i++) {
      const password = generateReadablePassword();
      expect(password).toMatch(/[a-z]/);
    }
  });

  it("contains at least one digit", () => {
    for (let i = 0; i < 20; i++) {
      const password = generateReadablePassword();
      expect(password).toMatch(/\d/);
    }
  });

  it("contains at least one special character", () => {
    for (let i = 0; i < 20; i++) {
      const password = generateReadablePassword();
      expect(password).toMatch(/[@$!%*?&]/);
    }
  });

  it("generates different passwords on successive calls", () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 20; i++) {
      passwords.add(generateReadablePassword());
    }
    // With 42 words, 7 specials, 90 digit combos = ~1.1M possibilities
    // 20 calls should produce at least 2 unique passwords
    expect(passwords.size).toBeGreaterThan(1);
  });
});

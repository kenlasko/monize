import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { resolveUserEmailLocale } from "./resolve-user-email-locale";

describe("resolveUserEmailLocale", () => {
  const makeRepo = (language: string | null | undefined) =>
    ({
      findOne: jest
        .fn()
        .mockResolvedValue(
          language === undefined ? null : { userId: "u1", language },
        ),
    }) as unknown as Repository<UserPreference> & {
      findOne: jest.Mock;
    };

  it("returns the recipient's stored concrete language", async () => {
    const repo = makeRepo("fr");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("fr");
    expect(repo.findOne).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("returns a regional variant when stored", async () => {
    const repo = makeRepo("pt-BR");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("pt-BR");
  });

  it("falls back to the default locale when the user has no preferences row", async () => {
    const repo = makeRepo(undefined);
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("ignores the 'browser' follow-the-browser sentinel", async () => {
    const repo = makeRepo("browser");
    // No HTTP context in a unit test, so this resolves to the default locale.
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("ignores an unsupported stored value", async () => {
    const repo = makeRepo("klingon");
    await expect(resolveUserEmailLocale(repo, "u1")).resolves.toBe("en");
  });

  it("does not query when there is no recipient user id", async () => {
    const repo = makeRepo("fr");
    await expect(resolveUserEmailLocale(repo, null)).resolves.toBe("en");
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});

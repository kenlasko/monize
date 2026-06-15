import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdatePreferencesDto } from "./update-preferences.dto";

async function languageError(language: string) {
  const dto = plainToInstance(UpdatePreferencesDto, { language });
  const errors = await validate(dto);
  return errors.find((e) => e.property === "language");
}

describe("UpdatePreferencesDto language validation", () => {
  it.each(["browser", "en", "fr", "pt-BR", "en-US", "en-GB"])(
    "accepts %s",
    async (language) => {
      expect(await languageError(language)).toBeUndefined();
    },
  );

  it.each(["EN", "english", "browserx", "e", "en_US", "en-gb"])(
    "rejects %s",
    async (language) => {
      expect(await languageError(language)).toBeDefined();
    },
  );
});

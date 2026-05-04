import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { ScenarioInputs } from "./scenario-inputs";

export class CreateScenarioDto extends ScenarioInputs {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  description?: string;
}

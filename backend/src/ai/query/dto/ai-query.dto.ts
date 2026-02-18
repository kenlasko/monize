import { IsString, MaxLength, IsNotEmpty } from "class-validator";
import { SanitizeHtml } from "../../../common/decorators/sanitize-html.decorator";

export class AiQueryDto {
  @IsString()
  @MaxLength(2000)
  @IsNotEmpty()
  @SanitizeHtml()
  query: string;
}

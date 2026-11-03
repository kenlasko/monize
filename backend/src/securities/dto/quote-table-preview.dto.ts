import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsUrl, MaxLength } from "class-validator";

export class QuoteTablePreviewDto {
  @ApiProperty({
    example:
      "https://www.ariva.de/1-unze-kruegerrand-gold-kurs/kurse/historische-kurse",
    description: "Web page whose price table is read and previewed",
  })
  @IsString()
  @MaxLength(2048)
  @IsUrl({
    protocols: ["http", "https"],
    require_protocol: true,
    require_tld: true,
  })
  url: string;
}

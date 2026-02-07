import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, MaxLength, IsIn } from 'class-validator';

export class UpdatePreferencesDto {
  @ApiPropertyOptional({ description: 'Default currency code (ISO 4217)', example: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  defaultCurrency?: string;

  @ApiPropertyOptional({
    description: 'Date format (browser = use browser locale)',
    example: 'browser',
  })
  @IsOptional()
  @IsString()
  dateFormat?: string;

  @ApiPropertyOptional({
    description: 'Number format locale (browser = use browser locale)',
    example: 'browser',
  })
  @IsOptional()
  @IsString()
  numberFormat?: string;

  @ApiPropertyOptional({ description: 'Theme preference', example: 'light' })
  @IsOptional()
  @IsString()
  @IsIn(['light', 'dark', 'system'])
  theme?: string;

  @ApiPropertyOptional({ description: 'Timezone (browser = use browser timezone)', example: 'browser' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ description: 'Receive email notifications' })
  @IsOptional()
  @IsBoolean()
  notificationEmail?: boolean;

  @ApiPropertyOptional({ description: 'Receive browser notifications' })
  @IsOptional()
  @IsBoolean()
  notificationBrowser?: boolean;

  @ApiPropertyOptional({ description: 'Dismiss the Getting Started guide' })
  @IsOptional()
  @IsBoolean()
  gettingStartedDismissed?: boolean;
}

import { IsBoolean, IsOptional } from "class-validator";

/**
 * 2C granular: owner toggles a delegate's per-resource create/edit/delete
 * capabilities for shared reference data. READ is always allowed and is not
 * represented here. Omitted fields are left unchanged.
 */
export class SetCapabilitiesDto {
  @IsOptional() @IsBoolean() payeesCanCreate?: boolean;
  @IsOptional() @IsBoolean() payeesCanEdit?: boolean;
  @IsOptional() @IsBoolean() payeesCanDelete?: boolean;

  @IsOptional() @IsBoolean() categoriesCanCreate?: boolean;
  @IsOptional() @IsBoolean() categoriesCanEdit?: boolean;
  @IsOptional() @IsBoolean() categoriesCanDelete?: boolean;

  @IsOptional() @IsBoolean() tagsCanCreate?: boolean;
  @IsOptional() @IsBoolean() tagsCanEdit?: boolean;
  @IsOptional() @IsBoolean() tagsCanDelete?: boolean;
}

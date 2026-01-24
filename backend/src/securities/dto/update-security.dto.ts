import { PartialType } from '@nestjs/swagger';
import { CreateSecurityDto } from './create-security.dto';

export class UpdateSecurityDto extends PartialType(CreateSecurityDto) {}

import { PartialType } from '@nestjs/swagger';
import { CreateCustomReportDto } from './create-custom-report.dto';

export class UpdateCustomReportDto extends PartialType(CreateCustomReportDto) {}

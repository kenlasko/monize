import { PartialType } from "@nestjs/swagger";
import { CreatePayeeDto } from "./create-payee.dto";

export class UpdatePayeeDto extends PartialType(CreatePayeeDto) {}

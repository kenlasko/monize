import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { ParseUUIDPipe } from "@nestjs/common";
import { ImportService } from "./import.service";
import {
  ParseQifDto,
  ImportQifDto,
  ParseOfxDto,
  ImportOfxDto,
  ParseCsvHeadersDto,
  ParseCsvDto,
  ImportCsvDto,
  CreateColumnMappingDto,
  UpdateColumnMappingDto,
  ParsedQifResponseDto,
  ImportResultDto,
  CsvHeadersResponseDto,
  ColumnMappingResponseDto,
} from "./dto/import.dto";

@ApiTags("Import")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("import")
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  // --- QIF ---

  @Post("qif/parse")
  @ApiOperation({ summary: "Parse a QIF file and return metadata for mapping" })
  @ApiResponse({
    status: 200,
    description: "QIF file parsed successfully",
    type: ParsedQifResponseDto,
  })
  async parseQif(
    @Request() req,
    @Body() dto: ParseQifDto,
  ): Promise<ParsedQifResponseDto> {
    return this.importService.parseQifFile(req.user.id, dto.content);
  }

  @Post("qif")
  @ApiOperation({ summary: "Import transactions from a QIF file" })
  @ApiResponse({
    status: 201,
    description: "Transactions imported successfully",
    type: ImportResultDto,
  })
  async importQif(
    @Request() req,
    @Body() dto: ImportQifDto,
  ): Promise<ImportResultDto> {
    return this.importService.importQifFile(req.user.id, dto);
  }

  // --- OFX ---

  @Post("ofx/parse")
  @ApiOperation({
    summary: "Parse an OFX file and return metadata for mapping",
  })
  @ApiResponse({
    status: 200,
    description: "OFX file parsed successfully",
    type: ParsedQifResponseDto,
  })
  async parseOfx(
    @Request() req,
    @Body() dto: ParseOfxDto,
  ): Promise<ParsedQifResponseDto> {
    return this.importService.parseOfxFile(req.user.id, dto.content);
  }

  @Post("ofx")
  @ApiOperation({ summary: "Import transactions from an OFX file" })
  @ApiResponse({
    status: 201,
    description: "Transactions imported successfully",
    type: ImportResultDto,
  })
  async importOfx(
    @Request() req,
    @Body() dto: ImportOfxDto,
  ): Promise<ImportResultDto> {
    return this.importService.importOfxFile(req.user.id, dto);
  }

  // --- CSV ---

  @Post("csv/headers")
  @ApiOperation({
    summary: "Parse CSV headers and return sample data for column mapping",
  })
  @ApiResponse({
    status: 200,
    description: "CSV headers parsed successfully",
    type: CsvHeadersResponseDto,
  })
  async parseCsvHeaders(
    @Request() req,
    @Body() dto: ParseCsvHeadersDto,
  ): Promise<CsvHeadersResponseDto> {
    return this.importService.parseCsvHeaders(
      req.user.id,
      dto.content,
      dto.delimiter,
    );
  }

  @Post("csv/parse")
  @ApiOperation({
    summary: "Parse a CSV file with column mapping and return metadata",
  })
  @ApiResponse({
    status: 200,
    description: "CSV file parsed successfully",
    type: ParsedQifResponseDto,
  })
  async parseCsv(
    @Request() req,
    @Body() dto: ParseCsvDto,
  ): Promise<ParsedQifResponseDto> {
    return this.importService.parseCsvFile(
      req.user.id,
      dto.content,
      dto.columnMapping as any,
      dto.transferRules as any,
    );
  }

  @Post("csv")
  @ApiOperation({ summary: "Import transactions from a CSV file" })
  @ApiResponse({
    status: 201,
    description: "Transactions imported successfully",
    type: ImportResultDto,
  })
  async importCsv(
    @Request() req,
    @Body() dto: ImportCsvDto,
  ): Promise<ImportResultDto> {
    return this.importService.importCsvFile(req.user.id, dto);
  }

  // --- Column Mappings CRUD ---

  @Get("column-mappings")
  @ApiOperation({ summary: "Get all saved CSV column mappings" })
  @ApiResponse({
    status: 200,
    description: "Column mappings retrieved",
    type: [ColumnMappingResponseDto],
  })
  async getColumnMappings(@Request() req): Promise<ColumnMappingResponseDto[]> {
    return this.importService.getColumnMappings(req.user.id);
  }

  @Post("column-mappings")
  @ApiOperation({ summary: "Save a CSV column mapping" })
  @ApiResponse({
    status: 201,
    description: "Column mapping saved",
    type: ColumnMappingResponseDto,
  })
  async createColumnMapping(
    @Request() req,
    @Body() dto: CreateColumnMappingDto,
  ): Promise<ColumnMappingResponseDto> {
    return this.importService.createColumnMapping(req.user.id, dto);
  }

  @Put("column-mappings/:id")
  @ApiOperation({ summary: "Update a saved CSV column mapping" })
  @ApiResponse({
    status: 200,
    description: "Column mapping updated",
    type: ColumnMappingResponseDto,
  })
  async updateColumnMapping(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateColumnMappingDto,
  ): Promise<ColumnMappingResponseDto> {
    return this.importService.updateColumnMapping(req.user.id, id, dto);
  }

  @Delete("column-mappings/:id")
  @ApiOperation({ summary: "Delete a saved CSV column mapping" })
  @ApiResponse({ status: 200, description: "Column mapping deleted" })
  async deleteColumnMapping(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.importService.deleteColumnMapping(req.user.id, id);
  }
}

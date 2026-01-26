import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ImportService } from './import.service';
import {
  ParseQifDto,
  ImportQifDto,
  ParsedQifResponseDto,
  ImportResultDto,
} from './dto/import.dto';

@ApiTags('Import')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post('qif/parse')
  @ApiOperation({ summary: 'Parse a QIF file and return metadata for mapping' })
  @ApiResponse({
    status: 200,
    description: 'QIF file parsed successfully',
    type: ParsedQifResponseDto,
  })
  async parseQif(
    @Request() req,
    @Body() dto: ParseQifDto,
  ): Promise<ParsedQifResponseDto> {
    return this.importService.parseQifFile(req.user.id, dto.content);
  }

  @Post('qif')
  @ApiOperation({ summary: 'Import transactions from a QIF file' })
  @ApiResponse({
    status: 201,
    description: 'Transactions imported successfully',
    type: ImportResultDto,
  })
  async importQif(
    @Request() req,
    @Body() dto: ImportQifDto,
  ): Promise<ImportResultDto> {
    return this.importService.importQifFile(req.user.id, dto);
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CreateCustomReportDto } from './dto/create-custom-report.dto';
import { UpdateCustomReportDto } from './dto/update-custom-report.dto';
import { ExecuteReportDto } from './dto/execute-report.dto';
import { CustomReport } from './entities/custom-report.entity';

@ApiTags('Custom Reports')
@Controller('reports/custom')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new custom report' })
  @ApiResponse({ status: 201, description: 'Report created successfully', type: CustomReport })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  create(
    @Request() req,
    @Body() createCustomReportDto: CreateCustomReportDto,
  ): Promise<CustomReport> {
    return this.reportsService.create(req.user.id, createCustomReportDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all custom reports for the current user' })
  @ApiResponse({ status: 200, description: 'List of custom reports', type: [CustomReport] })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  findAll(@Request() req): Promise<CustomReport[]> {
    return this.reportsService.findAll(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific custom report by ID' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  @ApiResponse({ status: 200, description: 'Report details', type: CustomReport })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  findOne(@Request() req, @Param('id') id: string): Promise<CustomReport> {
    return this.reportsService.findOne(req.user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a custom report' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  @ApiResponse({ status: 200, description: 'Report updated successfully', type: CustomReport })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  update(
    @Request() req,
    @Param('id') id: string,
    @Body() updateCustomReportDto: UpdateCustomReportDto,
  ): Promise<CustomReport> {
    return this.reportsService.update(req.user.id, id, updateCustomReportDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a custom report' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  @ApiResponse({ status: 200, description: 'Report deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  remove(@Request() req, @Param('id') id: string): Promise<void> {
    return this.reportsService.remove(req.user.id, id);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Execute a custom report and get aggregated data' })
  @ApiParam({ name: 'id', description: 'Report ID' })
  @ApiResponse({ status: 200, description: 'Report execution result' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Report not found' })
  execute(
    @Request() req,
    @Param('id') id: string,
    @Body() executeReportDto: ExecuteReportDto,
  ) {
    return this.reportsService.execute(req.user.id, id, executeReportDto);
  }
}

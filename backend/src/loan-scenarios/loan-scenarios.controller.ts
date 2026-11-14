import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { LoanScenariosService } from "./loan-scenarios.service";
import { CreateLoanScenarioDto } from "./dto/create-loan-scenario.dto";
import { UpdateLoanScenarioDto } from "./dto/update-loan-scenario.dto";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

@ApiTags("Loan Scenarios")
@AllowPat()
@Controller("accounts/:accountId/loan-scenarios")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class LoanScenariosController {
  constructor(private readonly loanScenariosService: LoanScenariosService) {}

  @Get()
  @AllowDelegate()
  @ApiOperation({ summary: "Get all saved scenarios for a loan account" })
  @ApiResponse({ status: 200, description: "Scenarios retrieved successfully" })
  @ApiResponse({ status: 404, description: "Account not found" })
  findAll(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ) {
    return this.loanScenariosService.findAll(req.user.id, accountId);
  }

  @Post()
  @ApiOperation({ summary: "Save a new overpayment scenario" })
  @ApiResponse({ status: 201, description: "Scenario created successfully" })
  @ApiResponse({ status: 404, description: "Account not found" })
  @ApiResponse({ status: 409, description: "Scenario name already exists" })
  create(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Body() createDto: CreateLoanScenarioDto,
  ) {
    return this.loanScenariosService.create(req.user.id, accountId, createDto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a saved scenario" })
  @ApiResponse({ status: 200, description: "Scenario updated successfully" })
  @ApiResponse({ status: 404, description: "Scenario not found" })
  @ApiResponse({ status: 409, description: "Scenario name already exists" })
  update(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateLoanScenarioDto,
  ) {
    return this.loanScenariosService.update(
      req.user.id,
      accountId,
      id,
      updateDto,
    );
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a saved scenario" })
  @ApiResponse({ status: 200, description: "Scenario deleted successfully" })
  @ApiResponse({ status: 404, description: "Scenario not found" })
  remove(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.loanScenariosService.remove(req.user.id, accountId, id);
  }
}

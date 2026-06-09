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
  Res,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Response } from "express";
import { InstitutionsService } from "./institutions.service";
import { CreateInstitutionDto } from "./dto/create-institution.dto";
import { UpdateInstitutionDto } from "./dto/update-institution.dto";
import { AssignAccountDto } from "./dto/assign-account.dto";
import { Institution } from "./entities/institution.entity";
import { Account } from "../accounts/entities/account.entity";

@ApiTags("Institutions")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("institutions")
export class InstitutionsController {
  constructor(private readonly institutionsService: InstitutionsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new financial institution" })
  @ApiResponse({
    status: 201,
    description: "Institution created",
    type: Institution,
  })
  @ApiResponse({ status: 409, description: "Institution name already exists" })
  create(@Request() req, @Body() dto: CreateInstitutionDto) {
    return this.institutionsService.create(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: "Get all institutions for the authenticated user" })
  @ApiResponse({ status: 200, description: "List of institutions" })
  findAll(@Request() req) {
    return this.institutionsService.findAll(req.user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a single institution by ID" })
  @ApiResponse({ status: 200, description: "Institution details" })
  @ApiResponse({ status: 404, description: "Institution not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.institutionsService.findOne(req.user.id, id);
  }

  @Get(":id/logo")
  @ApiOperation({
    summary: "Stream the cached brand favicon for an institution",
  })
  @ApiResponse({ status: 200, description: "Logo image bytes" })
  @ApiResponse({ status: 404, description: "Institution or logo not found" })
  async getLogo(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { data, contentType } = await this.institutionsService.getLogo(
      req.user.id,
      id,
    );
    res.set({
      "Content-Type": contentType,
      "Content-Length": String(data.length),
      // Per-user cached image; safe to cache in the browser for a day.
      "Cache-Control": "private, max-age=86400",
    });
    res.end(data);
  }

  @Post(":id/refresh-logo")
  @ApiOperation({ summary: "Re-fetch the brand favicon for an institution" })
  @ApiResponse({ status: 200, description: "Institution with refreshed logo" })
  @ApiResponse({ status: 404, description: "Institution not found" })
  refreshLogo(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.institutionsService.refreshLogo(req.user.id, id);
  }

  @Get(":id/accounts")
  @ApiOperation({ summary: "List accounts assigned to an institution" })
  @ApiResponse({ status: 200, description: "Accounts", type: [Account] })
  @ApiResponse({ status: 404, description: "Institution not found" })
  getAccounts(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.institutionsService.getAccounts(req.user.id, id);
  }

  @Post(":id/accounts")
  @ApiOperation({ summary: "Assign an account to an institution" })
  @ApiResponse({ status: 201, description: "Account assigned", type: Account })
  @ApiResponse({ status: 404, description: "Institution or account not found" })
  assignAccount(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AssignAccountDto,
  ) {
    return this.institutionsService.assignAccount(
      req.user.id,
      id,
      dto.accountId,
    );
  }

  @Delete(":id/accounts/:accountId")
  @ApiOperation({ summary: "Remove an account from an institution" })
  @ApiResponse({
    status: 200,
    description: "Account unassigned",
    type: Account,
  })
  @ApiResponse({ status: 404, description: "Institution or account not found" })
  unassignAccount(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ) {
    return this.institutionsService.unassignAccount(req.user.id, id, accountId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update an institution" })
  @ApiResponse({ status: 200, description: "Institution updated" })
  @ApiResponse({ status: 404, description: "Institution not found" })
  @ApiResponse({ status: 409, description: "Institution name already exists" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstitutionDto,
  ) {
    return this.institutionsService.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an institution" })
  @ApiResponse({ status: 200, description: "Institution deleted" })
  @ApiResponse({ status: 404, description: "Institution not found" })
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.institutionsService.remove(req.user.id, id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";

import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { CreateWarrantyClaimDto } from "./dto/create-warranty-claim.dto";
import { UpdateWarrantyClaimDto } from "./dto/update-warranty-claim.dto";
import {
  WarrantyClaimView,
  WarrantyClaimsService,
} from "./warranty-claims.service";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * The claims made against one warranty
 * (docs/specs/warranty-tracker.md section 6.5).
 *
 * The GET carries `@AllowDelegate()` with
 * `@DelegateRequiresSection("warranties")`: a delegate with the section reads
 * a warranty's claims. The mutations stay owner-only by the global
 * `AccountDelegateGuard`'s default (design decision 9).
 *
 * `userId` comes from the JWT on every route and is never read from the request.
 */
@ApiTags("Warranties")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("warranties/:id/claims")
export class WarrantyClaimsController {
  constructor(private readonly claimsService: WarrantyClaimsService) {}

  @Get()
  @AllowDelegate()
  @DelegateRequiresSection("warranties")
  @ApiOperation({ summary: "List a warranty's claims, newest first" })
  @ApiResponse({ status: 200, description: "The warranty's claims" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  findAll(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WarrantyClaimView[]> {
    return this.claimsService.findAll(req.user.id, id);
  }

  @Post()
  @ApiOperation({ summary: "Record a claim against a warranty" })
  @ApiResponse({ status: 201, description: "The created claim" })
  @ApiResponse({ status: 400, description: "Invalid status or dates" })
  @ApiResponse({ status: 404, description: "Warranty not found" })
  create(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return this.claimsService.create(req.user.id, id, dto);
  }

  @Patch(":claimId")
  @ApiOperation({ summary: "Update a claim" })
  @ApiResponse({ status: 200, description: "The updated claim" })
  @ApiResponse({ status: 400, description: "Invalid status or dates" })
  @ApiResponse({ status: 404, description: "Warranty or claim not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("claimId", ParseUUIDPipe) claimId: string,
    @Body() dto: UpdateWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return this.claimsService.update(req.user.id, id, claimId, dto);
  }

  @Delete(":claimId")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a claim" })
  @ApiResponse({ status: 204, description: "Deleted" })
  @ApiResponse({ status: 404, description: "Warranty or claim not found" })
  async remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("claimId", ParseUUIDPipe) claimId: string,
  ): Promise<void> {
    await this.claimsService.remove(req.user.id, id, claimId);
  }
}

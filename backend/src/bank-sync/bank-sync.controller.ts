import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Request as ExpressRequest } from "express";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { BankSyncConnectionsService } from "./bank-sync-connections.service";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncService } from "./bank-sync.service";
import type {
  BankInstitutionView,
  BankSyncAccountView,
  BankSyncAuthorizationStartView,
  BankSyncConnectionSyncEntry,
  BankSyncConnectionView,
  BankSyncCredentialsTestView,
  BankSyncLinkDefaultsView,
  BankSyncMatchedConnectionView,
  BankSyncPreviewView,
  BankSyncRemovedExceptionsView,
  BankSyncResult,
  BankSyncStatusView,
} from "./bank-sync.types";
import { BankSyncCallbackDto } from "./dto/bank-sync-callback.dto";
import { CreateBankSyncConnectionDto } from "./dto/create-bank-sync-connection.dto";
import { LinkBankSyncAccountDto } from "./dto/link-bank-sync-account.dto";
import { LinkDefaultsQueryDto } from "./dto/link-defaults-query.dto";
import { ListInstitutionsQueryDto } from "./dto/list-institutions-query.dto";
import { RemoveBankSyncExceptionsDto } from "./dto/remove-bank-sync-exceptions.dto";
import { SaveBankSyncCredentialsDto } from "./dto/save-bank-sync-credentials.dto";
import { SyncBankSyncAccountDto } from "./dto/sync-bank-sync-account.dto";
import { UpdateBankSyncConnectionDto } from "./dto/update-bank-sync-connection.dto";
import { psuContextOf } from "./psu-context.util";
import { selectionOf } from "./bank-sync-selection";

type AuthedRequest = ExpressRequest & { user: { id: string } };

/**
 * Bank sync (docs/specs/bank-sync.md section 9). Owner only: there is no
 * `@AllowDelegate`, so the global delegate guard refuses an "acting as" session.
 * Every route takes the user from the JWT, every `:id` goes through
 * `ParseUUIDPipe`, and every write is demo-restricted.
 *
 * The routes that reach the provider or the bank (`connections`, `callback`,
 * `test`, `match`, `preview`, both syncs) are throttled: each spends the user's provider quota.
 */
@ApiTags("Bank sync")
@Controller("bank-sync")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BankSyncController {
  constructor(
    private readonly credentials: BankSyncCredentialsService,
    private readonly connections: BankSyncConnectionsService,
    private readonly bankSync: BankSyncService,
  ) {}

  @Get("status")
  @ApiOperation({
    summary: "Bank sync availability, credentials and redirect URL",
  })
  getStatus(@Request() req: AuthedRequest): Promise<BankSyncStatusView> {
    return this.credentials.getStatus(req.user.id);
  }

  @Put("credentials")
  @DemoRestricted()
  @ApiOperation({
    summary: "Store the provider application id and private key",
  })
  saveCredentials(
    @Request() req: AuthedRequest,
    @Body() dto: SaveBankSyncCredentialsDto,
  ): Promise<BankSyncStatusView> {
    return this.credentials.save(req.user.id, dto);
  }

  @Delete("credentials")
  @DemoRestricted()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete the stored provider credentials" })
  deleteCredentials(@Request() req: AuthedRequest): Promise<void> {
    return this.credentials.remove(req.user.id);
  }

  @Post("credentials/test")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: "Check the stored credentials with the provider" })
  testCredentials(
    @Request() req: AuthedRequest,
  ): Promise<BankSyncCredentialsTestView> {
    return this.credentials.test(req.user.id);
  }

  @Get("institutions")
  @ApiOperation({ summary: "List the banks the provider offers in a country" })
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  listInstitutions(
    @Request() req: AuthedRequest,
    @Query() query: ListInstitutionsQueryDto,
  ): Promise<BankInstitutionView[]> {
    return this.connections.listInstitutions(req.user.id, query.country);
  }

  @Get("connections")
  @ApiOperation({ summary: "List bank connections with their bank accounts" })
  listConnections(
    @Request() req: AuthedRequest,
  ): Promise<BankSyncConnectionView[]> {
    return this.connections.list(req.user.id);
  }

  @Post("connections")
  @DemoRestricted()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: "Start authorizing access at a bank" })
  startConnection(
    @Request() req: AuthedRequest,
    @Body() dto: CreateBankSyncConnectionDto,
  ): Promise<BankSyncAuthorizationStartView> {
    return this.connections.start(req.user.id, dto);
  }

  @Post("connections/:id/reauthorize")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: "Renew the consent of an existing connection" })
  @ApiParam({ name: "id", description: "Connection ID" })
  reauthorize(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<BankSyncAuthorizationStartView> {
    return this.connections.reauthorize(req.user.id, id);
  }

  @Post("callback")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: "Complete an authorization with the bank's redirect",
  })
  completeCallback(
    @Request() req: AuthedRequest,
    @Body() dto: BankSyncCallbackDto,
  ): Promise<BankSyncMatchedConnectionView> {
    return this.connections.completeCallback(req.user.id, dto);
  }

  @Patch("connections/:id")
  @DemoRestricted()
  @ApiOperation({
    summary:
      "Turn the daily sync of a connection on or off, set when it reports success, or choose whether it tags transactions with the bank's operation type",
  })
  @ApiParam({ name: "id", description: "Connection ID" })
  updateConnection(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankSyncConnectionDto,
  ): Promise<BankSyncConnectionView> {
    return this.connections.updateConnection(req.user.id, id, {
      autoSync: dto.autoSync,
      notifySuccess: dto.notifySuccess,
      tagOperationType: dto.tagOperationType,
    });
  }

  @Delete("connections/:id")
  @DemoRestricted()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Disconnect a bank" })
  @ApiParam({ name: "id", description: "Connection ID" })
  disconnect(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.connections.disconnect(req.user.id, id);
  }

  @Post("connections/:id/match")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: "Link bank accounts to the accounts their number names",
  })
  @ApiParam({ name: "id", description: "Connection ID" })
  matchAccounts(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<BankSyncMatchedConnectionView> {
    return this.connections.matchAccounts(
      req.user.id,
      id,
      psuContextOf(req, userAgent),
    );
  }

  @Get("accounts/:id/link-defaults")
  @ApiOperation({
    summary: "The cut-off date a link to an account would default to",
  })
  @ApiParam({ name: "id", description: "Bank account ID" })
  linkDefaults(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: LinkDefaultsQueryDto,
  ): Promise<BankSyncLinkDefaultsView> {
    return this.bankSync.linkDefaults(req.user.id, id, query.accountId);
  }

  @Patch("accounts/:id")
  @DemoRestricted()
  @ApiOperation({ summary: "Link a bank account to an account, or unlink it" })
  @ApiParam({ name: "id", description: "Bank account ID" })
  linkAccount(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkBankSyncAccountDto,
  ): Promise<BankSyncAccountView> {
    return this.bankSync.linkAccount(req.user.id, id, dto);
  }

  @Post("accounts/:id/preview")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: "Preview what syncing one bank account would import",
  })
  @ApiParam({ name: "id", description: "Bank account ID" })
  previewAccount(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<BankSyncPreviewView> {
    return this.bankSync.previewAccount(
      req.user.id,
      id,
      psuContextOf(req, userAgent),
    );
  }

  @Post("accounts/:id/sync")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: "Sync one bank account now" })
  @ApiParam({ name: "id", description: "Bank account ID" })
  syncAccount(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto?: SyncBankSyncAccountDto,
    @Headers("user-agent") userAgent?: string,
  ): Promise<BankSyncResult> {
    return this.bankSync.syncAccount(
      req.user.id,
      id,
      psuContextOf(req, userAgent),
      dto?.planFingerprint || undefined,
      selectionOf(dto?.importKeys, dto?.excludeKeys),
    );
  }

  @Post("accounts/:id/exceptions/remove")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Take transactions back out of a bank account's exceptions, so the next sync shows them as new again",
  })
  @ApiParam({ name: "id", description: "Bank account ID" })
  removeExceptions(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RemoveBankSyncExceptionsDto,
  ): Promise<BankSyncRemovedExceptionsView> {
    return this.bankSync.removeExceptions(req.user.id, id, dto.keys);
  }

  @Post("connections/:id/sync")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: "Sync every linked bank account of a connection" })
  @ApiParam({ name: "id", description: "Connection ID" })
  syncConnection(
    @Request() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("user-agent") userAgent?: string,
  ): Promise<BankSyncConnectionSyncEntry[]> {
    return this.bankSync.syncConnection(
      req.user.id,
      id,
      psuContextOf(req, userAgent),
    );
  }
}

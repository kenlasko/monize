import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  ConnectedApp,
  OAuthConnectionsService,
} from "./oauth-connections.service";
import { ParseOAuthGrantIdPipe } from "./parse-oauth-grant-id.pipe";

/**
 * Settings > Connected apps. Session-only like the rest of `oauth/` (no
 * `@AllowPat()`), and closed to an acting delegate by the global
 * `AccountDelegateGuard`: an MCP credential is always the owner's own.
 */
@ApiTags("OAuth connected apps")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("oauth-connections")
export class OAuthConnectionsController {
  constructor(private readonly connections: OAuthConnectionsService) {}

  @Get()
  @ApiOperation({ summary: "List the apps connected to this account" })
  async list(
    @Request() req: { user: { id: string } },
  ): Promise<ConnectedApp[]> {
    return this.connections.list(req.user.id);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Revoke one connected app" })
  async revoke(
    @Request() req: { user: { id: string } },
    @Param("id", ParseOAuthGrantIdPipe) id: string,
  ): Promise<void> {
    await this.connections.revoke(req.user.id, id);
  }
}

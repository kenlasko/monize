import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { PatService } from "./pat.service";
import { CreatePatDto } from "./dto/create-pat.dto";

@ApiTags("Personal Access Tokens")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("auth/tokens")
export class PatController {
  constructor(private readonly patService: PatService) {}

  @Get()
  @ApiOperation({ summary: "List all personal access tokens" })
  async list(@Request() req: any) {
    return this.patService.findAllByUser(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: "Create a new personal access token" })
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async create(@Request() req: any, @Body() dto: CreatePatDto) {
    const { token, rawToken } = await this.patService.create(req.user.id, dto);
    return {
      id: token.id,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
      token: rawToken,
    };
  }

  @Delete(":id")
  @ApiOperation({ summary: "Revoke a personal access token" })
  async revoke(@Request() req: any, @Param("id", ParseUUIDPipe) id: string) {
    await this.patService.revoke(req.user.id, id);
    return { message: "Token revoked" };
  }
}

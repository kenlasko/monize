import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { MonteCarloService } from "./monte-carlo.service";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import { UpdateScenarioDto } from "./dto/update-scenario.dto";
import { RunScenarioDto } from "./dto/run-scenario.dto";
import { ReorderScenariosDto } from "./dto/reorder-scenarios.dto";
import { parseUuids } from "../common/query-param-utils";
import { rateLimit } from "../common/throttle.util";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * A simulation runs synchronously on the event loop (up to 50,000 paths x 200
 * years), so the two run routes carry a per-route ceiling well under the
 * global 100 a minute, like the other CPU- or provider-heavy routes.
 */
export const MONTE_CARLO_RUN_THROTTLE = {
  default: { ttl: 60_000, limit: rateLimit(10) },
};

interface AuthRequest extends Request {
  user: { id: string };
}

@AllowPat()
@Controller("monte-carlo")
@UseGuards(AuthGuard("jwt"))
export class MonteCarloController {
  constructor(private monteCarloService: MonteCarloService) {}

  @Get("scenarios")
  list(@Request() req: AuthRequest) {
    return this.monteCarloService.findAll(req.user.id);
  }

  @Post("scenarios")
  create(@Request() req: AuthRequest, @Body() dto: CreateScenarioDto) {
    return this.monteCarloService.create(req.user.id, dto);
  }

  // Registered before `scenarios/:id` so the literal "reorder" segment isn't
  // captured as a UUID by ParseUUIDPipe.
  @Patch("scenarios/reorder")
  @HttpCode(HttpStatus.NO_CONTENT)
  reorder(@Request() req: AuthRequest, @Body() dto: ReorderScenariosDto) {
    return this.monteCarloService.reorder(req.user.id, dto.scenarioIds);
  }

  @Get("scenarios/:id")
  findOne(@Request() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.monteCarloService.findOne(req.user.id, id);
  }

  @Patch("scenarios/:id")
  update(
    @Request() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateScenarioDto,
  ) {
    return this.monteCarloService.update(req.user.id, id, dto);
  }

  @Delete("scenarios/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Request() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.monteCarloService.remove(req.user.id, id);
  }

  @Post("scenarios/:id/run")
  @Throttle(MONTE_CARLO_RUN_THROTTLE)
  runSaved(
    @Request() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.monteCarloService.runSaved(req.user.id, id);
  }

  @Post("run")
  @Throttle(MONTE_CARLO_RUN_THROTTLE)
  run(@Request() req: AuthRequest, @Body() dto: RunScenarioDto) {
    return this.monteCarloService.runAdHoc(req.user.id, dto);
  }

  @Get("historical-stats")
  historicalStats(
    @Request() req: AuthRequest,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids = parseUuids(accountIds) ?? [];
    return this.monteCarloService.getHistoricalStats(req.user.id, ids);
  }

  @Get("holding-stats")
  holdingStats(
    @Request() req: AuthRequest,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids = parseUuids(accountIds) ?? [];
    return this.monteCarloService.getHoldingStats(req.user.id, ids);
  }

  /** Brokerage and standalone investment accounts only — use this to populate
   * the account picker (excludes the cash sibling of brokerage pairs). */
  @Get("accounts")
  brokerageAccounts(@Request() req: AuthRequest) {
    return this.monteCarloService.getBrokerageAccounts(req.user.id);
  }
}

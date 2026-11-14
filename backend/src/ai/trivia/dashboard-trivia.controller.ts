import { Controller, Get, Request, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { AllowPat } from "../../auth/pat-access/pat-access.decorator";

// No @AllowDelegate(): a delegate sees no hero, and the sentences draw on the
// owner's whole ledger, so the route fails closed for one.
@ApiTags("AI Insights")
@AllowPat()
@Controller("ai/trivia")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class DashboardTriviaController {
  constructor(private readonly triviaService: DashboardTriviaService) {}

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: "Get today's dashboard trivia" })
  getTrivia(@Request() req: { user: { id: string } }) {
    return this.triviaService.getTrivia(req.user.id);
  }
}

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
import { Throttle } from "@nestjs/throttler";
import { rateLimit } from "../../common/throttle.util";
import { OwnerOnly } from "../../delegation/decorators/delegate-access.decorator";
import { QuickAddInterpretDto } from "./dto/quick-add-interpret.dto";
import { QuickAddInterpretService } from "./quick-add-interpret.service";
import type { QuickAddInterpretation } from "./quick-add.types";

/**
 * Quick Add on the Transactions page (`docs/future-plans/quick-add.md`).
 *
 * The reader's own ledger only: `@OwnerOnly()` makes `AccountDelegateGuard`
 * refuse an acting delegate with 403, the fail-closed default made explicit,
 * and with no `@AllowPat()` a personal access token is refused too, so the
 * route is reachable only from a signed-in session. `userId` is the JWT's,
 * never a body field.
 *
 * A separate controller under `transactions/quick-add` rather than a route on
 * `TransactionsController`: no route there has the two literal segments
 * `quick-add/interpret` in its shape (`quick-add.controller.spec.ts` holds
 * that), and it is registered before that controller in the module.
 */
/**
 * The interpret route's own ceiling. The client asks on every pause in typing
 * (200 ms after the last key) and again on every chip change, so a reader
 * typing slowly on a phone, a pause after most keys, asks about once per
 * character: some 25 times for a line, and Save & New starts the next line at
 * once. 120 a minute keeps four or five such lines a minute free of refusals;
 * a desktop typist, who pauses between words rather than keys, asks far
 * less. Each reading is CPU work on the shared event loop, bounded per
 * request (`docs/future-plans/quick-add.md`, "Bounds"), so the ceiling also
 * bounds what one client can spend of it in a minute.
 */
export const QUICK_ADD_INTERPRET_THROTTLE = {
  default: { ttl: 60_000, limit: rateLimit(120) },
};

@ApiTags("Transactions")
@Controller("transactions/quick-add")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class QuickAddController {
  constructor(private readonly quickAdd: QuickAddInterpretService) {}

  @Post("interpret")
  @Throttle(QUICK_ADD_INTERPRET_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Read a one-line transaction entry as fields",
    description:
      "Read-only: nothing is written. The text goes in the body so it never reaches an access log. Save the result through POST /transactions or POST /transactions/transfer.",
  })
  @ApiResponse({ status: 200, description: "The interpretation" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Not available while acting for another user",
  })
  @ApiResponse({
    status: 404,
    description: "A pinned account, payee or category is not the caller's",
  })
  interpret(
    @Request() req: { user: { id: string } },
    @Body() dto: QuickAddInterpretDto,
  ): Promise<QuickAddInterpretation> {
    return this.quickAdd.interpret(req.user.id, dto);
  }
}

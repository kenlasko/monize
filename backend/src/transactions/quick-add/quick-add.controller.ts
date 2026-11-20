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
@ApiTags("Transactions")
@Controller("transactions/quick-add")
@UseGuards(AuthGuard("jwt"))
@OwnerOnly()
@ApiBearerAuth()
export class QuickAddController {
  constructor(private readonly quickAdd: QuickAddInterpretService) {}

  @Post("interpret")
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

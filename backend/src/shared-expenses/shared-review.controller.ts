import { Controller, Get, Request, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { SharedReviewService } from "./shared-review.service";

@ApiTags("Shared expenses: private finances")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("shared-expenses/private-finances/review")
export class SharedReviewController {
  constructor(private readonly review: SharedReviewService) {}
  @Get()
  summary(@Request() req: { user: { id: string } }) {
    return this.review.summary(req.user.id);
  }
}

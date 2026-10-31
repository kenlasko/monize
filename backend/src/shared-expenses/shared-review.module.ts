import { Module } from "@nestjs/common";
import { SharedReviewService } from "./shared-review.service";
import { SharedReviewController } from "./shared-review.controller";

@Module({
  providers: [SharedReviewService],
  controllers: [SharedReviewController],
  exports: [SharedReviewService],
})
export class SharedReviewModule {}

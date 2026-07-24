import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ToursService } from "./tours.service";
import { SaveTourProgressDto } from "./dto/save-tour-progress.dto";

@ApiTags("Updates")
@ApiBearerAuth()
@Controller("updates/tours")
@UseGuards(AuthGuard("jwt"))
export class ToursController {
  constructor(private readonly toursService: ToursService) {}

  @Get("progress")
  @ApiOperation({
    summary: "Get the user's guided-tour completion map.",
  })
  getProgress(@Request() req) {
    return this.toursService.getProgress(req.user.id);
  }

  @Post("progress")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Record a guided tour as completed or dismissed.",
  })
  saveProgress(@Request() req, @Body() dto: SaveTourProgressDto) {
    return this.toursService.saveProgress(req.user.id, dto.tourId, dto.status);
  }

  @Delete("progress")
  @ApiOperation({
    summary: "Clear all guided-tour progress (Reset tour progress).",
  })
  resetProgress(@Request() req) {
    return this.toursService.resetProgress(req.user.id);
  }
}

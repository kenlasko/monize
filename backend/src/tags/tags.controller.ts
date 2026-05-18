import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { TagsService } from "./tags.service";
import { CreateTagDto } from "./dto/create-tag.dto";
import { UpdateTagDto } from "./dto/update-tag.dto";
import {
  AllowDelegate,
  DelegateRequiresCapability,
} from "../delegation/decorators/delegate-access.decorator";

@ApiTags("Tags")
@Controller("tags")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ApiOperation({ summary: "Get all tags for the authenticated user" })
  @ApiResponse({ status: 200, description: "Tags retrieved successfully" })
  @AllowDelegate()
  findAll(@Request() req) {
    return this.tagsService.findAll(req.user.id);
  }

  @Get("transaction-counts")
  @AllowDelegate()
  @ApiOperation({ summary: "Get transaction counts for all tags" })
  @ApiResponse({
    status: 200,
    description: "Transaction counts retrieved successfully",
  })
  getAllTransactionCounts(@Request() req) {
    return this.tagsService.getAllTransactionCounts(req.user.id);
  }

  @Get(":id")
  @AllowDelegate()
  @ApiOperation({ summary: "Get a tag by ID" })
  @ApiResponse({ status: 200, description: "Tag retrieved successfully" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.tagsService.findOne(req.user.id, id);
  }

  @Get(":id/transaction-count")
  @AllowDelegate()
  @ApiOperation({ summary: "Get number of transactions using this tag" })
  @ApiResponse({ status: 200, description: "Count retrieved successfully" })
  getTransactionCount(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.tagsService.getTransactionCount(req.user.id, id);
  }

  @Post()
  @ApiOperation({ summary: "Create a new tag" })
  @ApiResponse({ status: 201, description: "Tag created successfully" })
  @ApiResponse({ status: 409, description: "Tag name already exists" })
  @AllowDelegate()
  @DelegateRequiresCapability("tags", "create")
  create(@Request() req, @Body() createTagDto: CreateTagDto) {
    return this.tagsService.create(req.user.id, createTagDto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a tag" })
  @ApiResponse({ status: 200, description: "Tag updated successfully" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  @AllowDelegate()
  @DelegateRequiresCapability("tags", "edit")
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTagDto: UpdateTagDto,
  ) {
    return this.tagsService.update(req.user.id, id, updateTagDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a tag" })
  @ApiResponse({ status: 200, description: "Tag deleted successfully" })
  @ApiResponse({ status: 404, description: "Tag not found" })
  @AllowDelegate()
  @DelegateRequiresCapability("tags", "delete")
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.tagsService.remove(req.user.id, id);
  }
}

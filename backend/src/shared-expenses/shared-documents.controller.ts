import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { memoryStorage } from "multer";
import { MAX_ATTACHMENT_BYTES } from "../attachments/attachments.service";
import { SharedDocumentsService } from "./shared-documents.service";
import {
  PublishSharedDocumentDto,
  SharedDocumentUploadDto,
  UpdateSharedDocumentDto,
} from "./dto/shared-document.dto";
import { SharedListDto } from "./dto/shared-entry.dto";

type SharedRequest = { user: { id: string } };
type UploadParts = {
  file?: Express.Multer.File[];
  original?: Express.Multer.File[];
};
const uploadPair = FileFieldsInterceptor(
  [
    { name: "file", maxCount: 1 },
    { name: "original", maxCount: 1 },
  ],
  {
    storage: memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 2 },
  },
);

@ApiTags("Shared expense documents")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("shared-expenses/groups/:groupId")
export class SharedDocumentsController {
  constructor(private readonly documents: SharedDocumentsService) {}

  @Get("documents")
  list(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Query() query: SharedListDto,
  ) {
    return this.documents.list(req.user.id, groupId, query.offset);
  }

  @Get("attachments")
  async groupList(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
  ) {
    return (await this.documents.list(req.user.id, groupId, 0, undefined, true))
      .items;
  }

  @Get("entries/:entryId/attachments")
  async entryList(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
  ) {
    return (await this.documents.list(req.user.id, groupId, 0, entryId)).items;
  }

  @Post("attachments")
  @UseInterceptors(uploadPair)
  uploadGroup(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: SharedDocumentUploadDto,
    @UploadedFiles() files: UploadParts,
  ) {
    return this.documents.upload(
      req.user.id,
      groupId,
      undefined,
      dto,
      files?.file?.[0],
      files?.original?.[0],
    );
  }

  @Post("entries/:entryId/attachments")
  @UseInterceptors(uploadPair)
  uploadEntry(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body() dto: SharedDocumentUploadDto,
    @UploadedFiles() files: UploadParts,
  ) {
    return this.documents.upload(
      req.user.id,
      groupId,
      entryId,
      dto,
      files?.file?.[0],
      files?.original?.[0],
    );
  }

  @Post("documents/publish")
  publish(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Body() dto: PublishSharedDocumentDto,
  ) {
    return this.documents.publish(req.user.id, groupId, dto);
  }

  @Patch("documents/:id")
  update(
    @Request() req: SharedRequest,
    @Param("groupId", ParseUUIDPipe) groupId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSharedDocumentDto,
  ) {
    return this.documents.update(req.user.id, groupId, id, dto);
  }
}

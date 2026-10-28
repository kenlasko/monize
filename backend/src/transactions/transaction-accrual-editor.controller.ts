import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { AccrualsService } from "../accruals/accruals.service";
import {
  AccrualEditorCommitDto,
  AccrualEditorPreviewDto,
} from "../accruals/dto/accrual-editor.dto";
import { accrualErrors } from "../accruals/accrual-errors";
import { TransactionsService } from "./transactions.service";

@ApiTags("Transactions")
@ApiBearerAuth()
@Controller("transactions/:id/accrual-editor")
@UseGuards(AuthGuard("jwt"))
export class TransactionAccrualEditorController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly accruals: AccrualsService,
  ) {}
  @Post("preview")
  preview(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AccrualEditorPreviewDto,
  ) {
    return this.accruals.editorPreview(req.user.id, id, dto);
  }
  @Post()
  @DemoRestricted()
  save(
    @Request() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AccrualEditorCommitDto,
  ) {
    const userId = req.user.id;
    return this.transactions.update(userId, id, dto.patch, {
      reviewAccrualEditor: async () => {
        const value = await this.accruals.editorPreview(userId, id, dto);
        if (value.fingerprint !== dto.fingerprint)
          throw accrualErrors.conflict();
        return value.impactFingerprint;
      },
      afterSourceWrite: async () => {
        await this.accruals.applyEditorSettings(userId, id, dto);
      },
    });
  }
}

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { TagsService } from "./tags.service";
import { TagsController } from "./tags.controller";
import { ActionHistoryModule } from "../action-history/action-history.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Tag, TransactionTag, TransactionSplitTag]),
    ActionHistoryModule,
  ],
  providers: [TagsService],
  controllers: [TagsController],
  exports: [TagsService],
})
export class TagsModule {}

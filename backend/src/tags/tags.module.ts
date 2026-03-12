import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { TagsService } from "./tags.service";
import { TagsController } from "./tags.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([Tag, TransactionTag, TransactionSplitTag]),
  ],
  providers: [TagsService],
  controllers: [TagsController],
  exports: [TagsService],
})
export class TagsModule {}

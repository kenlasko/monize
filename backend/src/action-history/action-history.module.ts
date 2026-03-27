import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ActionHistory } from "./entities/action-history.entity";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistoryController } from "./action-history.controller";

@Module({
  imports: [TypeOrmModule.forFeature([ActionHistory])],
  providers: [ActionHistoryService],
  controllers: [ActionHistoryController],
  exports: [ActionHistoryService],
})
export class ActionHistoryModule {}

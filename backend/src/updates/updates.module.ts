import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";

@Module({
  imports: [TypeOrmModule.forFeature([UserPreference])],
  controllers: [UpdatesController],
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}

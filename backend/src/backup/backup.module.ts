import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { User } from "../users/entities/user.entity";

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}

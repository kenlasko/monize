import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BackupController } from "./backup.controller";
import { BackupService } from "./backup.service";
import { User } from "../users/entities/user.entity";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [TypeOrmModule.forFeature([User]), AuthModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}

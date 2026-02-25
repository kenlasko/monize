import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserPreference,
      RefreshToken,
      PersonalAccessToken,
    ]),
  ],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}

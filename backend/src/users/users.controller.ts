import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdatePreferencesDto } from "./dto/update-preferences.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { DeleteAccountDto } from "./dto/delete-account.dto";
import { DeleteDataDto } from "./dto/delete-data.dto";
import { SkipPasswordCheck } from "../auth/decorators/skip-password-check.decorator";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";

@ApiTags("Users")
@Controller("users")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  @SkipPasswordCheck()
  @AllowDelegate()
  @ApiOperation({ summary: "Get current user profile" })
  async getProfile(@Request() req) {
    const user = await this.usersService.findById(req.user.id);
    if (!user) return null;
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...rest
    } = user as any;
    return { ...rest, hasPassword: !!passwordHash };
  }

  @Patch("profile")
  @DemoRestricted()
  @ApiOperation({ summary: "Update current user profile" })
  @ApiResponse({ status: 200, description: "Profile updated successfully" })
  updateProfile(@Request() req, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.id, dto);
  }

  @Get("preferences")
  @AllowDelegate()
  @ApiOperation({ summary: "Get current user preferences" })
  getPreferences(@Request() req) {
    return this.usersService.getPreferences(req.user.id);
  }

  @Patch("preferences")
  @ApiOperation({ summary: "Update current user preferences" })
  @ApiResponse({ status: 200, description: "Preferences updated successfully" })
  updatePreferences(@Request() req, @Body() dto: UpdatePreferencesDto) {
    return this.usersService.updatePreferences(req.user.id, dto);
  }

  @Post("change-password")
  @SkipPasswordCheck()
  @AllowDelegate()
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Change current user password" })
  @ApiResponse({ status: 200, description: "Password changed successfully" })
  @ApiResponse({
    status: 400,
    description: "Invalid current password or validation error",
  })
  async changePassword(@Request() req, @Body() dto: ChangePasswordDto) {
    // Security: a delegate acting as an owner manages their OWN password,
    // not the owner's — use realUserId so the change always targets the
    // authenticated identity regardless of acting context.
    await this.usersService.changePassword(req.user.realUserId, dto);
    return { message: "Password changed successfully" };
  }

  @Post("delete-account")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Delete current user account with re-authentication",
  })
  @ApiResponse({ status: 200, description: "Account deleted successfully" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async deleteAccount(@Request() req, @Body() dto: DeleteAccountDto) {
    const result = await this.usersService.deleteAccount(req.user.id, dto);
    return {
      message: result.downgraded
        ? "Your own data was removed. Your login and any shared access others granted you remain."
        : "Account deleted successfully",
      downgraded: result.downgraded,
    };
  }

  @Post("delete-data")
  @DemoRestricted()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete user data with re-authentication" })
  @ApiResponse({ status: 200, description: "Data deleted successfully" })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async deleteData(@Request() req, @Body() dto: DeleteDataDto) {
    return this.usersService.deleteData(req.user.id, dto);
  }
}

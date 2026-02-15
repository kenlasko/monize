import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdatePreferencesDto } from "./dto/update-preferences.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    // SECURITY: Require password confirmation when changing email to prevent
    // account takeover via compromised session
    if (dto.email && dto.email !== user.email) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          "Current password is required to change email address",
        );
      }
      if (!user.passwordHash) {
        throw new BadRequestException(
          "Cannot change email for accounts without a local password",
        );
      }
      const isPasswordValid = await bcrypt.compare(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!isPasswordValid) {
        throw new BadRequestException("Current password is incorrect");
      }
      const existingUser = await this.usersRepository.findOne({
        where: { email: dto.email },
      });
      if (existingUser) {
        throw new ConflictException("Email already in use");
      }
      user.email = dto.email;
    }

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }

    const saved = await this.usersRepository.save(user);
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...rest
    } = saved;
    return { ...rest, hasPassword: !!passwordHash };
  }

  async getPreferences(userId: string): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    // Create default preferences if they don't exist
    // Default to 'browser' for locale-dependent settings
    if (!preferences) {
      // Use direct instantiation to ensure primary key is set
      preferences = new UserPreference();
      preferences.userId = userId;
      preferences.defaultCurrency = "USD";
      preferences.dateFormat = "browser";
      preferences.numberFormat = "browser";
      preferences.theme = "system";
      preferences.timezone = "browser";
      preferences.notificationEmail = true;
      preferences.notificationBrowser = true;
      preferences.twoFactorEnabled = false;
      preferences.gettingStartedDismissed = false;
      await this.preferencesRepository.save(preferences);
    }

    return preferences;
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      // Create with defaults first
      preferences = await this.getPreferences(userId);
    }

    // Update only provided fields
    if (dto.defaultCurrency !== undefined) {
      preferences.defaultCurrency = dto.defaultCurrency;
    }
    if (dto.dateFormat !== undefined) {
      preferences.dateFormat = dto.dateFormat;
    }
    if (dto.numberFormat !== undefined) {
      preferences.numberFormat = dto.numberFormat;
    }
    if (dto.theme !== undefined) {
      preferences.theme = dto.theme;
    }
    if (dto.timezone !== undefined) {
      preferences.timezone = dto.timezone;
    }
    if (dto.notificationEmail !== undefined) {
      preferences.notificationEmail = dto.notificationEmail;
    }
    if (dto.notificationBrowser !== undefined) {
      preferences.notificationBrowser = dto.notificationBrowser;
    }
    if (dto.gettingStartedDismissed !== undefined) {
      preferences.gettingStartedDismissed = dto.gettingStartedDismissed;
    }

    return this.preferencesRepository.save(preferences);
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    if (!user.passwordHash) {
      throw new BadRequestException("No password set for this account");
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new BadRequestException("Current password is incorrect");
    }

    // Hash and save new password
    const saltRounds = 10;
    user.passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);
    user.mustChangePassword = false;
    await this.usersRepository.save(user);

    // SECURITY: Revoke all refresh tokens to force re-login on all devices
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  async deleteAccount(userId: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    // SECURITY: Prevent the last admin from self-deleting, which would leave
    // the system with no administrator
    if (user.role === "admin") {
      const adminCount = await this.usersRepository.count({
        where: { role: "admin" },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException(
          "Cannot delete the last admin account. Promote another user first.",
        );
      }
    }

    // Delete preferences first (due to FK constraint)
    await this.preferencesRepository.delete({ userId });

    // Revoke all refresh tokens before deletion
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    // Delete the user
    await this.usersRepository.remove(user);
  }
}

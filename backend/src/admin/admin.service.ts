import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { generateReadablePassword } from "./utils/password-generator";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { UsersService } from "../users/users.service";

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
    @InjectRepository(PersonalAccessToken)
    private patRepository: Repository<PersonalAccessToken>,
    private oauthProviderService: OAuthProviderService,
    private usersService: UsersService,
  ) {}

  async findAllUsers() {
    // Hide owner-managed delegate identities -- users that exist solely
    // because an account owner added them via Shared Access. Those rows
    // are managed from the owner's Shared Access page. The is_delegate_only
    // column is set when createDelegate provisions a new user and cleared
    // when the user upgrades into a full account via the /register claim
    // path, so a self-registered user who happens to also be a delegate
    // still shows up here.
    const users = await this.usersRepository.find({
      where: { isDelegateOnly: false },
      order: { createdAt: "ASC" },
    });
    return users.map((user) => {
      const {
        passwordHash,
        resetToken,
        resetTokenExpiry,
        twoFactorSecret,
        ...rest
      } = user;
      return { ...rest, hasPassword: !!passwordHash };
    });
  }

  private sanitizeUser(user: User) {
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...rest
    } = user;
    return { ...rest, hasPassword: !!passwordHash };
  }

  async updateUserRole(adminId: string, targetUserId: string, role: string) {
    if (adminId === targetUserId) {
      throw new ForbiddenException("You cannot change your own role");
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException("User not found");
    }

    // Prevent removing the last admin
    if (targetUser.role === "admin" && role === "user") {
      const adminCount = await this.usersRepository.count({
        where: { role: "admin" },
      });
      if (adminCount <= 1) {
        throw new BadRequestException(
          "Cannot remove the last admin. Promote another user first.",
        );
      }
    }

    targetUser.role = role;
    const saved = await this.usersRepository.save(targetUser);
    return this.sanitizeUser(saved);
  }

  async updateUserStatus(
    adminId: string,
    targetUserId: string,
    isActive: boolean,
  ): Promise<
    Omit<
      User,
      "passwordHash" | "resetToken" | "resetTokenExpiry" | "twoFactorSecret"
    > & { hasPassword: boolean }
  > {
    if (adminId === targetUserId) {
      throw new ForbiddenException("You cannot disable your own account");
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException("User not found");
    }

    targetUser.isActive = isActive;
    const saved = await this.usersRepository.save(targetUser);

    // SECURITY: Revoke all refresh tokens, PATs, and OIDC artifacts when
    // deactivating a user to immediately invalidate every authenticated
    // surface — web sessions (refresh tokens), CLI/API access (PATs), and
    // MCP/OAuth clients (access + refresh tokens, authorization codes,
    // grants, sessions). Without the OIDC sweep, an MCP client could keep
    // calling tools for up to the access-token TTL even after deactivation.
    if (!isActive) {
      await this.refreshTokensRepository.update(
        { userId: targetUserId, isRevoked: false },
        { isRevoked: true },
      );
      await this.patRepository.update(
        { userId: targetUserId, isRevoked: false },
        { isRevoked: true },
      );
      await this.oauthProviderService.revokeAllForUser(targetUserId);
    }

    return this.sanitizeUser(saved);
  }

  async deleteUser(
    adminId: string,
    targetUserId: string,
  ): Promise<{ downgraded: boolean }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException("You cannot delete your own account");
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException("User not found");
    }

    // Prevent deleting the last admin
    if (targetUser.role === "admin") {
      const adminCount = await this.usersRepository.count({
        where: { role: "admin" },
      });
      if (adminCount <= 1) {
        throw new BadRequestException("Cannot delete the last admin account.");
      }
    }

    // Revoke sessions/PATs and sweep OIDC artifacts (forces re-login and
    // avoids orphan oauth_payloads rows) -- needed whether the account is
    // fully removed or demoted to a delegate.
    await this.refreshTokensRepository.update(
      { userId: targetUserId, isRevoked: false },
      { isRevoked: true },
    );
    await this.patRepository.update(
      { userId: targetUserId, isRevoked: false },
      { isRevoked: true },
    );
    await this.oauthProviderService.revokeAllForUser(targetUserId);

    // A full account that is also a delegate of someone else is demoted to
    // a pure delegate instead of being removed: their own data goes, but
    // their login and the delegate access others granted them stay.
    if (await this.usersService.isActingDelegate(targetUserId)) {
      await this.usersService.purgeForDowngrade(targetUserId);
      return { downgraded: true };
    }

    // Delete preferences first (FK constraint), then the user.
    await this.preferencesRepository.delete({ userId: targetUserId });
    await this.usersRepository.remove(targetUser);
    return { downgraded: false };
  }

  async resetUserPassword(
    adminId: string,
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        "You cannot reset your own password through the admin panel",
      );
    }

    const targetUser = await this.usersRepository.findOne({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException("User not found");
    }

    if (!targetUser.passwordHash) {
      throw new BadRequestException(
        "Cannot reset password for accounts without a local password",
      );
    }

    const temporaryPassword = generateReadablePassword();
    const saltRounds = 12;
    targetUser.passwordHash = await bcrypt.hash(temporaryPassword, saltRounds);
    targetUser.mustChangePassword = true;
    targetUser.resetToken = null;
    targetUser.resetTokenExpiry = null;
    await this.usersRepository.save(targetUser);

    // SECURITY: Revoke all refresh tokens, PATs, and OIDC artifacts so the
    // forced password change applies everywhere — web, CLI/API, and MCP.
    await this.refreshTokensRepository.update(
      { userId: targetUserId, isRevoked: false },
      { isRevoked: true },
    );
    await this.patRepository.update(
      { userId: targetUserId, isRevoked: false },
      { isRevoked: true },
    );
    await this.oauthProviderService.revokeAllForUser(targetUserId);

    return { temporaryPassword };
  }
}

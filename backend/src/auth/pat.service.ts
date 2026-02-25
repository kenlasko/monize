import * as crypto from "crypto";
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { User } from "../users/entities/user.entity";
import { CreatePatDto } from "./dto/create-pat.dto";

const MAX_TOKENS_PER_USER = 10;

interface ValidatedToken {
  userId: string;
  scopes: string;
}

@Injectable()
export class PatService {
  constructor(
    @InjectRepository(PersonalAccessToken)
    private readonly patRepository: Repository<PersonalAccessToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(
    userId: string,
    dto: CreatePatDto,
  ): Promise<{ token: PersonalAccessToken; rawToken: string }> {
    const count = await this.patRepository.count({
      where: { userId, isRevoked: false },
    });
    if (count >= MAX_TOKENS_PER_USER) {
      throw new Error(
        `Maximum of ${MAX_TOKENS_PER_USER} active tokens per user`,
      );
    }

    const rawToken = "pat_" + crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 8);

    const token = this.patRepository.create({
      userId,
      name: dto.name,
      tokenPrefix,
      tokenHash,
      scopes: dto.scopes || "read",
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const saved = await this.patRepository.save(token);
    return { token: saved, rawToken };
  }

  async findAllByUser(userId: string): Promise<PersonalAccessToken[]> {
    return this.patRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      select: [
        "id",
        "name",
        "tokenPrefix",
        "scopes",
        "lastUsedAt",
        "expiresAt",
        "isRevoked",
        "createdAt",
      ],
    });
  }

  async validateToken(rawToken: string): Promise<ValidatedToken> {
    if (!rawToken || !rawToken.startsWith("pat_")) {
      throw new UnauthorizedException("Invalid token format");
    }

    const tokenHash = this.hashToken(rawToken);
    const token = await this.patRepository.findOne({
      where: { tokenHash },
    });

    if (!token) {
      throw new UnauthorizedException("Invalid token");
    }

    if (token.isRevoked) {
      throw new UnauthorizedException("Token has been revoked");
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new UnauthorizedException("Token has expired");
    }

    // SECURITY: Verify user account is active and not flagged for password change
    const user = await this.userRepository.findOne({
      where: { id: token.userId },
      select: ["id", "isActive", "mustChangePassword"],
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("User account is inactive");
    }
    if (user.mustChangePassword) {
      throw new UnauthorizedException("Password change required");
    }

    await this.patRepository.update(token.id, {
      lastUsedAt: new Date(),
    });

    return {
      userId: token.userId,
      scopes: token.scopes,
    };
  }

  async revoke(userId: string, tokenId: string): Promise<void> {
    const token = await this.patRepository.findOne({
      where: { id: tokenId, userId },
    });

    if (!token) {
      throw new NotFoundException("Token not found");
    }

    await this.patRepository.update(tokenId, { isRevoked: true });
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
}

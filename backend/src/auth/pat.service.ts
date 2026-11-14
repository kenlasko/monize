import * as crypto from "crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { User } from "../users/entities/user.entity";
import { CreatePatDto } from "./dto/create-pat.dto";
import { hashToken } from "./crypto.util";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";

const MAX_TOKENS_PER_USER = 10;

/**
 * How long a token lives when its creator names no expiry. A PAT works
 * without a second factor, so "forever" is something the caller asks for
 * (`expiresAt: null`), never what an omitted field means.
 */
export const DEFAULT_PAT_LIFETIME_DAYS = 90;

/**
 * `last_used_at` is written at most this often per token. It answers "is this
 * token still in use", which a minute's resolution answers as well, and a REST
 * client would otherwise turn every request into a row update.
 */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

/** `undefined` (omitted) is the default lifetime; `null` is no expiry. */
function resolveExpiry(expiresAt: string | null | undefined): Date | null {
  if (expiresAt === null) return null;
  if (expiresAt) return new Date(expiresAt);
  return new Date(Date.now() + DEFAULT_PAT_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
}

export interface ValidatedToken {
  userId: string;
  scopes: string;
  /**
   * The PAT row's id -- the credential fingerprint the MCP transport binds a
   * session to, so a session opened with a write token cannot be reused by a
   * different (narrower, or replacement-after-revocation) token of the same
   * user. Not a secret: the raw token is never stored, only its hash.
   */
  tokenId: string;
}

@Injectable()
export class PatService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  async create(
    userId: string,
    dto: CreatePatDto,
  ): Promise<{ token: PersonalAccessToken; rawToken: string }> {
    const rawToken = "pat_" + crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 8);

    // One transaction, and the owner's row locked inside it. The cap is a
    // read-modify-write: counting on one connection and inserting on another let
    // two concurrent creates both pass, and moving the count into the same
    // transaction would not have helped -- neither sees the other's uncommitted
    // insert. Serializing on the `users` row is what makes the count binding, and
    // there is no unique constraint that could catch it afterwards.
    const saved = await withScopedDb(this.dataSource, async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);

      const repo = manager.getRepository(PersonalAccessToken);
      const count = await repo.count({
        where: { userId, isRevoked: false },
      });
      if (count >= MAX_TOKENS_PER_USER) {
        throw new BadRequestException(
          tr(
            "errors.auth.maxTokensExceeded",
            `Maximum of ${MAX_TOKENS_PER_USER} active tokens per user`,
            { MAX_TOKENS_PER_USER },
          ),
        );
      }

      return repo.save(
        repo.create({
          userId,
          name: dto.name,
          tokenPrefix,
          tokenHash,
          scopes: dto.scopes || "read",
          expiresAt: resolveExpiry(dto.expiresAt),
        }),
      );
    });
    return { token: saved, rawToken };
  }

  async findAllByUser(userId: string): Promise<PersonalAccessToken[]> {
    return this.scoped(PersonalAccessToken, (repo) =>
      repo.find({
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
      }),
    );
  }

  async validateToken(rawToken: string): Promise<ValidatedToken> {
    // RLS: PAT authentication is pre-identity -- the token-hash lookup scans
    // personal_access_tokens across all users, before any req.user exists (all
    // MCP traffic authenticates here). Seed a system context so the lookup and
    // the lastUsedAt write have ambient identity once these repositories move
    // to withScopedDb (task R7). Inert until then.
    return withSystemContext(() => this.validateTokenWithinContext(rawToken));
  }

  private async validateTokenWithinContext(
    rawToken: string,
  ): Promise<ValidatedToken> {
    if (!rawToken || !rawToken.startsWith("pat_")) {
      throw new UnauthorizedException(
        tr("errors.auth.invalidTokenFormat", "Invalid token format"),
      );
    }

    const tokenHash = hashToken(rawToken);
    const token = await this.scoped(PersonalAccessToken, (repo) =>
      repo.findOne({
        where: { tokenHash },
      }),
    );

    if (!token) {
      throw new UnauthorizedException(
        tr("errors.auth.invalidToken", "Invalid token"),
      );
    }

    if (token.isRevoked) {
      throw new UnauthorizedException(
        tr("errors.auth.tokenRevoked", "Token has been revoked"),
      );
    }

    if (token.expiresAt && token.expiresAt < new Date()) {
      throw new UnauthorizedException(
        tr("errors.auth.tokenExpired", "Token has expired"),
      );
    }

    // SECURITY: Verify user account is active and not flagged for password change
    const user = await this.scoped(User, (repo) =>
      repo.findOne({
        where: { id: token.userId },
        select: ["id", "isActive", "mustChangePassword"],
      }),
    );
    if (!user || !user.isActive) {
      throw new UnauthorizedException(
        tr("errors.auth.userAccountInactive", "User account is inactive"),
      );
    }
    if (user.mustChangePassword) {
      throw new UnauthorizedException(
        tr("errors.auth.passwordChangeRequired", "Password change required"),
      );
    }

    const now = Date.now();
    if (
      !token.lastUsedAt ||
      now - token.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS
    ) {
      await this.scoped(PersonalAccessToken, (repo) =>
        repo.update(token.id, {
          lastUsedAt: new Date(now),
        }),
      );
    }

    return {
      userId: token.userId,
      scopes: token.scopes,
      tokenId: token.id,
    };
  }

  async revoke(userId: string, tokenId: string): Promise<void> {
    const token = await this.scoped(PersonalAccessToken, (repo) =>
      repo.findOne({
        where: { id: tokenId, userId },
      }),
    );

    if (!token) {
      throw new NotFoundException(
        tr("errors.auth.tokenNotFound", "Token not found"),
      );
    }

    await this.scoped(PersonalAccessToken, (repo) =>
      repo.update(tokenId, { isRevoked: true }),
    );
  }
}

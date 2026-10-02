import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { EncryptionService } from "../common/encryption/encryption.service";
import { tr } from "../i18n/translate";
import {
  BANK_SYNC_CALLBACK_PATH,
  BANK_SYNC_DEFAULT_PROVIDER,
} from "./bank-sync.constants";
import type { BankSyncProviderName } from "./bank-sync.constants";
import {
  BankSyncCredentialsUnavailableException,
  toBankSyncException,
} from "./bank-sync-errors";
import type { SaveBankSyncCredentialsDto } from "./dto/save-bank-sync-credentials.dto";
import { BankSyncCredential } from "./entities/bank-sync-credential.entity";
import type {
  BankSyncCredentialsTestView,
  BankSyncCredentialsView,
  BankSyncStatusView,
} from "./bank-sync.types";
import type { BankSyncCredentials } from "./providers/bank-sync-provider.interface";
import { isBankSyncProviderError } from "./providers/bank-sync-provider.errors";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";
import { parseRsaPrivateKey } from "./providers/enable-banking/enable-banking-jwt";

/**
 * The provider application a user registered: an application id and an RSA
 * private key (docs/specs/bank-sync.md sections 3, 4 and 9).
 *
 * **The key leaves this class in exactly one direction (INV-BANKSYNC-002).**
 * Every method that answers a request returns a view with `privateKeySet:
 * boolean` and no key field; the only method that decrypts is
 * `resolveCredentials`, whose result goes to a provider call and nowhere else.
 * There is no method here that hands the key, or its ciphertext, to an HTTP
 * response.
 *
 * A refusal happens before the write: the PEM is parsed before the row is
 * touched, and "no key stored and none supplied" is decided inside the same
 * transaction that would have stored the row.
 */
@Injectable()
export class BankSyncCredentialsService {
  private readonly logger = new Logger(BankSyncCredentialsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly configService: ConfigService,
    private readonly registry: BankSyncProviderRegistry,
  ) {}

  /**
   * The URL the user registers in the provider's control panel, and the URL
   * `startAuthorization` sends the bank back to: `PUBLIC_APP_URL` without a
   * trailing slash plus the settings callback page.
   */
  redirectUrl(): string {
    const base = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    return `${base.replace(/\/+$/, "")}${BANK_SYNC_CALLBACK_PATH}`;
  }

  async getStatus(userId: string): Promise<BankSyncStatusView> {
    const row = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BankSyncCredential).findOne({
        where: { userId, provider: BANK_SYNC_DEFAULT_PROVIDER },
      }),
    );
    return this.toStatus(row);
  }

  /**
   * PUT semantics. `applicationId` is always replaced; a missing `privateKey`
   * keeps the stored key and is refused when there is none, inside the
   * transaction that would have written the row.
   */
  async save(
    userId: string,
    dto: SaveBankSyncCredentialsDto,
  ): Promise<BankSyncStatusView> {
    const applicationId = dto.applicationId.trim();
    const pem = dto.privateKey?.trim() ? dto.privateKey.trim() : null;

    let encrypted: string | null = null;
    if (pem !== null) {
      if (!this.encryption.isConfigured()) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.encryptionNotConfigured",
            "This server cannot store a private key because ENCRYPTION_KEY is not set. Ask an administrator to configure it.",
          ),
        );
      }
      // Parsed before anything is written, and the crypto library's own message
      // is dropped: it is about the input, which is a secret.
      try {
        parseRsaPrivateKey(pem);
      } catch (error) {
        if (!isBankSyncProviderError(error)) throw error;
        throw new BadRequestException(
          tr(
            "errors.bankSync.privateKeyInvalid",
            "The private key could not be read. Paste an RSA private key in PEM format (it starts with -----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----).",
          ),
        );
      }
      encrypted = this.encryption.encrypt(pem);
    }

    const row = await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(BankSyncCredential);
      const existing = await repo.findOne({
        where: { userId, provider: BANK_SYNC_DEFAULT_PROVIDER },
        lock: { mode: "pessimistic_write" },
      });
      if (!existing && encrypted === null) {
        throw new BadRequestException(
          tr(
            "errors.bankSync.privateKeyRequired",
            "Paste the private key of your provider application; none is stored yet.",
          ),
        );
      }
      if (existing) {
        existing.applicationId = applicationId;
        if (encrypted !== null) existing.privateKeyEnc = encrypted;
        return repo.save(existing);
      }
      // A concurrent first save of the same user loses to the unique key rather
      // than duplicating; the later writer's values stand.
      await m.query(
        `INSERT INTO bank_sync_credentials (user_id, provider, application_id, private_key_enc)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, provider) DO UPDATE
            SET application_id = EXCLUDED.application_id,
                private_key_enc = EXCLUDED.private_key_enc`,
        [userId, BANK_SYNC_DEFAULT_PROVIDER, applicationId, encrypted],
      );
      return repo.findOneOrFail({
        where: { userId, provider: BANK_SYNC_DEFAULT_PROVIDER },
      });
    });
    return this.toStatus(row);
  }

  async remove(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      await m.getRepository(BankSyncCredential).delete({
        userId,
        provider: BANK_SYNC_DEFAULT_PROVIDER,
      });
    });
  }

  /** Proves the stored application is accepted, and names its redirect URLs. */
  async test(userId: string): Promise<BankSyncCredentialsTestView> {
    const credentials = await this.resolveCredentials(
      userId,
      BANK_SYNC_DEFAULT_PROVIDER,
    );
    const provider = this.registry.getByName(BANK_SYNC_DEFAULT_PROVIDER);
    try {
      const result = await provider.testCredentials(credentials);
      return {
        ok: true,
        applicationName: result.applicationName ?? "",
        redirectUrls: result.redirectUrls,
      };
    } catch (error) {
      throw toBankSyncException(error);
    }
  }

  /**
   * The user's credentials, decrypted for one provider call. The only decrypt
   * site of the feature.
   *
   * A row that cannot be decrypted (a rotated `ENCRYPTION_KEY`, a restore onto
   * another instance) is refused with a message that says what to do, and the
   * log line names the user and the fact, never the ciphertext or the error
   * the crypto library raised.
   */
  async resolveCredentials(
    userId: string,
    provider: BankSyncProviderName,
  ): Promise<BankSyncCredentials> {
    const row = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BankSyncCredential).findOne({
        where: { userId, provider },
      }),
    );
    if (!row) {
      throw new BankSyncCredentialsUnavailableException(
        tr(
          "errors.bankSync.credentialsRequired",
          "Enter your provider application id and private key in the bank sync settings first.",
        ),
      );
    }
    try {
      return {
        applicationId: row.applicationId,
        privateKeyPem: this.encryption.decrypt(row.privateKeyEnc),
      };
    } catch {
      this.logger.warn(
        `Bank sync credentials for user ${userId} could not be decrypted; ` +
          "they have to be entered again.",
      );
      throw new BankSyncCredentialsUnavailableException(
        tr(
          "errors.bankSync.credentialsUnreadable",
          "The stored private key can no longer be read on this server. Enter the application id and the private key again.",
        ),
      );
    }
  }

  private toStatus(row: BankSyncCredential | null): BankSyncStatusView {
    const credentials: BankSyncCredentialsView | null = row
      ? {
          provider: row.provider,
          applicationId: row.applicationId,
          privateKeySet: row.privateKeyEnc.length > 0,
        }
      : null;
    return {
      encryptionAvailable: this.encryption.isConfigured(),
      providers: [...this.registry.listNames()],
      credentials,
      redirectUrl: this.redirectUrl(),
    };
  }
}

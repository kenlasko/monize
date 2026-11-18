import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { tr } from "../i18n/translate";
import { displayClientName } from "./client-identity";
import { OAuthProviderService } from "./oauth-provider.service";
import {
  findGrantsForAccount,
  revokeGrantForAccount,
} from "./postgres.adapter";
import { describeRedirectTarget } from "./redirect-target";
import { MCP_SCOPE_PREFIX } from "../auth/scopes";

/** One connected app as Settings > Connected apps shows it. */
export interface ConnectedApp {
  /** The grant id: what Revoke names. */
  id: string;
  clientId: string;
  /** The name the client registered with, cleaned; never verified. */
  clientName: string;
  /** Whether the client registration still exists (it expires when idle). */
  clientKnown: boolean;
  /** Where the client's authorizations go: the origins of its redirect URIs. */
  destinations: string[];
  /** Granted scopes on the MCP resource, without the `monize:` prefix. */
  scopes: string[];
  grantedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/**
 * Settings > Connected apps: the OAuth grants a person has given, and revoking
 * one without changing the password (GHSA-vmgq-326p-fprx). Storage access is the
 * adapter's (`findGrantsForAccount`, `revokeGrantForAccount`); this service
 * only shapes the rows and asks the provider who each client says it is.
 */
@Injectable()
export class OAuthConnectionsService {
  private readonly logger = new Logger(OAuthConnectionsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly providerService: OAuthProviderService,
  ) {}

  async list(userId: string): Promise<ConnectedApp[]> {
    const grants = await findGrantsForAccount(this.dataSource, userId);
    const resource = this.providerService.getMcpResourceUrl();
    const clients = new Map<string, ClientFacts>();
    const apps: ConnectedApp[] = [];
    for (const grant of grants) {
      const clientId =
        typeof grant.payload.clientId === "string"
          ? grant.payload.clientId
          : "";
      let client = clients.get(clientId);
      if (!client) {
        client = await this.clientFacts(clientId);
        clients.set(clientId, client);
      }
      apps.push({
        id: grant.id,
        clientId,
        clientName: displayClientName(client.name, clientId || grant.id),
        clientKnown: client.known,
        destinations: client.destinations,
        scopes: grantedScopes(grant.payload, resource),
        grantedAt: epochSecondsToIso(grant.payload.iat),
        expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
        lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
      });
    }
    return apps;
  }

  async revoke(userId: string, grantId: string): Promise<void> {
    const revoked = await revokeGrantForAccount(
      this.dataSource,
      userId,
      grantId,
    );
    if (!revoked) {
      throw new NotFoundException(
        tr(
          "errors.oauth.connectionNotFound",
          "That connected app was not found. It may already have been revoked.",
        ),
      );
    }
  }

  /** What the stored client registration says; nothing when it has expired. */
  private async clientFacts(clientId: string): Promise<ClientFacts> {
    if (!clientId) return UNKNOWN_CLIENT;
    try {
      const client = await this.providerService
        .getProvider()
        .Client.find(clientId);
      if (!client) return UNKNOWN_CLIENT;
      const uris: unknown[] = Array.isArray(client.redirectUris)
        ? client.redirectUris
        : [];
      const destinations = [
        ...new Set(
          uris
            .map((uri) =>
              describeRedirectTarget(typeof uri === "string" ? uri : null),
            )
            .filter((origin): origin is string => origin !== null),
        ),
      ];
      return {
        known: true,
        name: typeof client.clientName === "string" ? client.clientName : null,
        destinations,
      };
    } catch (err) {
      this.logger.warn(
        `Client lookup failed for ${clientId}: ${(err as Error).message}`,
      );
      return UNKNOWN_CLIENT;
    }
  }
}

interface ClientFacts {
  known: boolean;
  name: string | null;
  destinations: string[];
}

const UNKNOWN_CLIENT: ClientFacts = {
  known: false,
  name: null,
  destinations: [],
};

/** The grant's scopes on the MCP resource, as `read` / `write`. */
function grantedScopes(
  payload: Record<string, unknown>,
  resource: string,
): string[] {
  const resources = payload.resources;
  const granted =
    resources && typeof resources === "object"
      ? (resources as Record<string, unknown>)[resource]
      : undefined;
  if (typeof granted !== "string") return [];
  return granted
    .split(/\s+/)
    .filter((scope) => scope.startsWith(MCP_SCOPE_PREFIX))
    .map((scope) => scope.slice(MCP_SCOPE_PREFIX.length));
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
}

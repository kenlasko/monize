import { Controller, Get } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import {
  OAuthProviderService,
  MCP_RESOURCE_SCOPES,
} from "./oauth-provider.service";

/**
 * Publishes RFC 9728 OAuth Protected Resource Metadata at the well-known
 * URL. MCP clients fetch this after a 401 to discover which authorization
 * server to use for the Monize MCP endpoint.
 *
 * Mounted at the application root (excluded from /api/v1) so it lives at
 * `${PUBLIC_APP_URL}/.well-known/oauth-protected-resource`, which is the
 * fixed location MCP clients probe.
 */
@ApiExcludeController()
@SkipCsrf()
@Controller(".well-known")
export class OAuthMetadataController {
  constructor(private readonly providerService: OAuthProviderService) {}

  @Get("oauth-protected-resource")
  protectedResource() {
    return {
      resource: this.providerService.getMcpResourceUrl(),
      authorization_servers: [this.providerService.getIssuerUrl()],
      scopes_supported: [...MCP_RESOURCE_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation:
        "https://modelcontextprotocol.io/specification/draft/basic/authorization",
    };
  }
}

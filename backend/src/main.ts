import { NestFactory } from "@nestjs/core";
import { Logger, RequestMethod, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as express from "express";
import * as cookieParser from "cookie-parser";
import * as pg from "pg";
import { AppModule } from "./app.module";
import { OAuthProviderService } from "./oauth/oauth-provider.service";
import { oauthDebugLogger } from "./oauth/oauth-debug-logger.middleware";

// Configure pg to return DATE types as strings instead of Date objects
// This prevents timezone-related date shifting issues
// OID 1082 = DATE type in PostgreSQL
pg.types.setTypeParser(1082, (val: string) => val);

// Configure pg to interpret TIMESTAMP WITHOUT TIME ZONE as UTC.
// PostgreSQL stores these as naive timestamps (no timezone info). The default
// pg parser creates a Date using the server's local timezone, which produces
// wrong UTC values when the server TZ is not UTC (e.g. America/Toronto).
// OID 1114 = TIMESTAMP WITHOUT TIME ZONE
pg.types.setTypeParser(1114, (val: string) => new Date(val + "Z"));

// Force pg to serialize Date parameters as UTC.
// The default pg serializer uses local-time getters (getFullYear, getHours, etc.)
// which produces wrong values for TIMESTAMP WITHOUT TIME ZONE columns when the
// server's local timezone is not UTC. This pairs with the read-side fix above.
function pad(n: number, digits = 2): string {
  return String(n).padStart(digits, "0");
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgUtils = require("pg/lib/utils");
const origPrepareValue = pgUtils.prepareValue;
pgUtils.prepareValue = function (val: unknown, seen?: unknown[]): unknown {
  if (val instanceof Date) {
    return `${val.getUTCFullYear()}-${pad(val.getUTCMonth() + 1)}-${pad(val.getUTCDate())}T${pad(val.getUTCHours())}:${pad(val.getUTCMinutes())}:${pad(val.getUTCSeconds())}.${pad(val.getUTCMilliseconds(), 3)}+00`;
  }
  return origPrepareValue(val, seen);
};

// Suppress Node.js 20 ERR_INTERNAL_ASSERTION in HTTP detachSocket.
// This fires asynchronously when NestJS @Res() handlers throw exceptions,
// causing a race between the exception filter's response and internal socket
// cleanup. The response is already sent to the client; only the socket
// bookkeeping assertion fails. Safe to suppress in dev; does not fire in prod.
if (process.env.NODE_ENV !== "production") {
  process.on("uncaughtException", (err: any) => {
    if (
      err?.code === "ERR_INTERNAL_ASSERTION" &&
      err?.stack?.includes("detachSocket")
    ) {
      return;
    }
    console.error("Uncaught exception:", err);
    process.exit(1);
  });
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Trust first proxy (Docker/nginx) so req.ip reflects the real client IP
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Backup restore accepts gzip-compressed binary (compressed on the client
  // to avoid multi-minute uploads of 100mb+ JSON files). Encrypted backups
  // are uploaded as the Monize envelope under application/octet-stream, so
  // both content-types must be parsed into a raw Buffer here -- otherwise the
  // controller sees an unparsed body and rejects it.
  app.use(
    "/api/v1/backup/restore",
    express.raw({
      limit: "100mb",
      type: ["application/gzip", "application/octet-stream"],
    }),
  );

  // Default body size limit for regular endpoints (QIF imports, etc.).
  // Skip body parsing for /oauth/* so node-oidc-provider parses requests
  // itself — otherwise it logs "already parsed request body detected" on
  // every DCR/token POST. The interaction routes under /api/v1/oauth-consent/*
  // need parsed bodies for @Body(), so they go through normal parsing.
  const skipForProvider =
    (parser: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => {
      if (req.path === "/oauth" || req.path.startsWith("/oauth/")) {
        return next();
      }
      return parser(req, res, next);
    };
  app.use(skipForProvider(express.json({ limit: "10mb" })));
  app.use(
    skipForProvider(express.urlencoded({ limit: "10mb", extended: true })),
  );

  // Cookie parser for OIDC state/nonce and auth tokens
  app.use(cookieParser());

  // OAuth/MCP debug-logger middleware mounted ahead of the global CORS
  // middleware so a request from an MCP client (Claude Desktop, mcp-remote)
  // is logged even when the strict app-wide CORS layer would have rejected
  // its Origin. CORS itself is path-aware further down (see app.enableCors
  // delegate) — these paths get permissive CORS because they authenticate
  // by Bearer token, not cookies.
  app.use("/api/v1/mcp", oauthDebugLogger("mcp"));
  app.use("/.well-known/oauth-protected-resource", oauthDebugLogger("prm"));
  app.use(
    "/.well-known/oauth-authorization-server",
    oauthDebugLogger("as-meta"),
  );
  app.use("/oauth", oauthDebugLogger("provider"));
  app.use("/api/v1/oauth-consent", oauthDebugLogger("consent"));

  // Security middleware
  const disableHttpsHeaders = process.env.DISABLE_HTTPS_HEADERS === "true";
  app.use(
    helmet({
      frameguard: { action: "deny" },
      hsts: disableHttpsHeaders
        ? false
        : { maxAge: 63072000, includeSubDomains: true, preload: true },
      crossOriginOpenerPolicy: disableHttpsHeaders
        ? false
        : { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Enable CORS
  const allowedOrigins = [
    process.env.PUBLIC_APP_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.NODE_ENV !== "production"
      ? [
          "http://localhost:3001",
          "http://localhost:3000",
          "http://127.0.0.1:3001",
          "http://127.0.0.1:3000",
        ]
      : []),
  ].filter(Boolean);

  // Path-aware CORS: the MCP and OAuth surfaces accept any origin
  // because they authenticate via Bearer tokens (PAT / OAuth access
  // token) and never receive cookies — a third-party origin can't ride
  // ambient credentials. The rest of the app keeps the strict allow-list
  // because it relies on cookies + CSRF for browser sessions.
  app.enableCors((req, callback) => {
    const path = req.path ?? req.url ?? "";
    const isOpenSurface =
      path === "/api/v1/mcp" ||
      path.startsWith("/api/v1/mcp/") ||
      path === "/oauth" ||
      path.startsWith("/oauth/") ||
      path.startsWith("/api/v1/oauth-consent/") ||
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-authorization-server" ||
      path.startsWith("/.well-known/oauth-authorization-server/");

    if (isOpenSurface) {
      callback(null, {
        origin: "*",
        credentials: false,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: [
          "Authorization",
          "Content-Type",
          "Accept",
          "Mcp-Session-Id",
          "Mcp-Protocol-Version",
        ],
        exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
        maxAge: 600,
      });
      return;
    }

    callback(null, {
      origin: (origin, cb) => {
        // Requests with no Origin header (server-to-server, health checks,
        // curl, same-origin navigations): always allow. Non-browser clients
        // can trivially set any Origin, so blocking null Origin adds no real
        // security. Sandboxed-iframe abuse is prevented by Helmet's
        // frameguard: { action: "deny" } instead.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "X-CSRF-Token",
        "X-Restore-Password",
        "X-Restore-OIDC-Token",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
    });
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix. The protected-resource metadata route (RFC 9728) is the
  // only NestJS-controller path that must live at the application root
  // because the spec fixes its URL. The interaction controller lives
  // under the normal /api/v1 prefix so it goes through the regular
  // /api/* forwarding path on the frontend proxy.
  app.setGlobalPrefix("api/v1", {
    exclude: [
      {
        path: ".well-known/oauth-protected-resource",
        method: RequestMethod.GET,
      },
    ],
  });

  // Mount node-oidc-provider as Express middleware at /oauth. This serves the
  // authorization, token, registration, JWKS, revocation, and discovery
  // endpoints. Helmet's restrictive CSP doesn't apply here because the
  // provider sets its own headers and renders no HTML of its own (we render
  // the consent page in the interaction controller).
  //
  // ensureInitialized() is awaited because Nest's onModuleInit hook may not
  // have run yet at this point (it fires inside app.listen() / app.init()).
  const oauthProviderService = app.get(OAuthProviderService);
  const oauthProvider = await oauthProviderService.ensureInitialized();
  // The debug-logger and permissive-CORS middlewares for /oauth/* etc. are
  // mounted earlier (before the global cookie/helmet/CORS chain) so that
  // requests from MCP clients with an off-allowlist Origin still appear in
  // the log. The provider middleware itself stays here because the OAuth
  // provider mounts its own interaction handlers.
  app.use("/oauth", oauthProvider.callback());

  // Swagger documentation (disabled in production)
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("Monize API")
      .setDescription("API for managing your personal finances via Monize")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  // Increase HTTP server timeouts for large backup uploads (100mb+).
  // Default requestTimeout is 5 min which may not be enough when uploading
  // through multiple proxy layers on slower connections.
  const server = app.getHttpServer();
  server.requestTimeout = 600000; // 10 minutes
  server.headersTimeout = 605000; // must be > requestTimeout

  const logger = new Logger("Bootstrap");
  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  if (process.env.NODE_ENV !== "production") {
    logger.log(`API Documentation: http://localhost:${port}/api/docs`);
  }
}

bootstrap();

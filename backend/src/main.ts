import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as express from "express";
import * as cookieParser from "cookie-parser";
import * as pg from "pg";
import { AppModule } from "./app.module";

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
  // to avoid multi-minute uploads of 100mb+ JSON files).
  app.use(
    "/api/v1/backup/restore",
    express.raw({ limit: "100mb", type: "application/gzip" }),
  );

  // Default body size limit for regular endpoints (QIF imports, etc.)
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));

  // Cookie parser for OIDC state/nonce and auth tokens
  app.use(cookieParser());

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

  app.enableCors({
    origin: (origin, callback) => {
      // Requests with no Origin header (server-to-server, health checks,
      // curl, same-origin navigations): always allow. Non-browser clients
      // can trivially set any Origin, so blocking null Origin adds no real
      // security. Sandboxed-iframe abuse is prevented by Helmet's
      // frameguard: { action: "deny" } instead.
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
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

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix
  app.setGlobalPrefix("api/v1");

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

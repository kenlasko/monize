import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";
import { tr } from "../i18n/translate";
import { rateLimit } from "../common/throttle.util";
import { HELP_IMAGE_NAME_RE, HELP_SLUG_RE } from "./help.constants";
import { HelpService } from "./help.service";
import { HelpManifest, HelpPage } from "./dto/help-response.dto";

/**
 * A picture requested with its current cache key (`?v=`, the running version
 * and the file's revision, which the app always sends) cannot change under that
 * URL, so it is cached for a year; any other request is revalidated every
 * time, so a browser never keeps an older release's or an older file's picture.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

/**
 * Public, read-only endpoint serving the bundled user guide.
 *
 * Intentionally unauthenticated, like the release notes: the guide is already
 * public at www.monize.net/docs, the login and two-factor screens need help
 * before there is a session, and it holds no user data. It takes only a slug,
 * which must match `^[a-z0-9-]+$` and be a page `nav.json` lists, or a picture's
 * name, which must be one the bundle holds; both are safe GETs (CSRF-exempt).
 * The global throttler still applies.
 */
@ApiTags("Help")
@Controller("help")
export class HelpController {
  constructor(private readonly helpService: HelpService) {}

  @Get()
  @ApiOperation({
    summary:
      "List the pages of the bundled user guide (public; works offline).",
  })
  getManifest(): HelpManifest {
    return this.helpService.getManifest();
  }

  @Get("pages/:slug")
  @ApiOperation({
    summary: "Get one page of the bundled user guide as Markdown (public).",
  })
  getPage(@Param("slug") slug: string): HelpPage {
    const page = HELP_SLUG_RE.test(slug)
      ? this.helpService.getPage(slug)
      : null;
    if (!page) {
      throw new NotFoundException(
        tr("errors.help.pageNotFound", "Help page not found"),
      );
    }
    return page;
  }

  // A page of pictures is one request each (the dashboard page has 28), so the
  // route has a budget of its own above the default; a cached picture costs none.
  @Get("images/:name")
  @Throttle({ default: { ttl: 60000, limit: rateLimit(300) } })
  @ApiOperation({
    summary:
      "Get one screenshot of the bundled user guide, `<name>` or `<name>.light` (public).",
  })
  async getImage(
    @Param("name") name: string,
    @Query("v") revision: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const image = HELP_IMAGE_NAME_RE.test(name)
      ? await this.helpService.getImage(name)
      : null;
    if (!image) {
      throw new NotFoundException(
        tr("errors.help.imageNotFound", "Help image not found"),
      );
    }
    res.setHeader("Content-Type", image.contentType);
    res.setHeader(
      "Cache-Control",
      revision === image.revision ? IMMUTABLE : REVALIDATE,
    );
    // Nothing is returned: a @Res() handler's return value still travels
    // through the global ClassSerializerInterceptor (res-handler-return.guard.spec.ts).
    res.send(image.data);
  }
}

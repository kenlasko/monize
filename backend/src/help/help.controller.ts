import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { tr } from "../i18n/translate";
import { HELP_SLUG_RE } from "./help.constants";
import { HelpService } from "./help.service";
import { HelpManifest, HelpPage } from "./dto/help-response.dto";

/**
 * Public, read-only endpoint serving the bundled user guide.
 *
 * Intentionally unauthenticated, like the release notes: the guide is already
 * public at www.monize.net/docs, the login and two-factor screens need help
 * before there is a session, and it holds no user data. It takes only a slug,
 * which must match `^[a-z0-9-]+$` and be a page `nav.json` lists, and is a safe
 * GET (CSRF-exempt). The global throttler still applies.
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
}

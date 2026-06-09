import { Injectable, Logger } from "@nestjs/common";

export interface FetchedLogo {
  data: Buffer;
  contentType: string;
}

/**
 * Resolves a financial institution's brand icon by fetching the website's
 * favicon from Google's faviconV2 (gstatic) endpoint -- the same resolver
 * Chrome uses -- entirely server-side. The bytes are cached in the database so
 * the user's browser never has to contact a third party to render the logo.
 */
@Injectable()
export class InstitutionLogoService {
  private readonly logger = new Logger(InstitutionLogoService.name);

  private static readonly TIMEOUT_MS = 6000;
  // Favicons at 256px are a few KB; cap generously to guard against a
  // misbehaving upstream returning something huge.
  private static readonly MAX_BYTES = 512 * 1024;

  /**
   * Build the gstatic faviconV2 URL for a website, requested at 256px.
   */
  buildFaviconUrl(website: string): string {
    return (
      "https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON" +
      "&fallback_opts=TYPE,SIZE,URL" +
      `&url=${encodeURIComponent(website)}&size=256`
    );
  }

  /**
   * Fetch the favicon for a website. Returns null on any failure (network
   * error, timeout, non-image response, empty or oversized payload) so callers
   * can treat the logo as best-effort and never fail the surrounding operation.
   */
  async fetchFavicon(website: string): Promise<FetchedLogo | null> {
    const url = this.buildFaviconUrl(website);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      InstitutionLogoService.TIMEOUT_MS,
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
      });

      if (!response.ok) {
        this.logger.warn(
          `Favicon fetch for ${website} returned HTTP ${response.status}`,
        );
        return null;
      }

      const rawContentType = response.headers.get("content-type") || "";
      const contentType = rawContentType.split(";")[0].trim().toLowerCase();
      if (!contentType.startsWith("image/")) {
        this.logger.warn(
          `Favicon fetch for ${website} returned non-image content-type "${rawContentType}"`,
        );
        return null;
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0 || data.length > InstitutionLogoService.MAX_BYTES) {
        this.logger.warn(
          `Favicon fetch for ${website} returned ${data.length} bytes (rejected)`,
        );
        return null;
      }

      return { data, contentType };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch favicon for ${website}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

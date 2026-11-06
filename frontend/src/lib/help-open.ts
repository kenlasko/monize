import { docsUrl, helpTarget, type DocsLink } from '@/lib/docs-links';
import { helpApi } from '@/lib/help';
import { useHelpStore } from '@/store/helpStore';

/**
 * Show the guide's page for a documentation key in the help panel.
 *
 * The panel opens only once the guide has been shown to be there: when the
 * server has no bundled guide, or the page cannot be fetched, the same
 * destination opens on monize.net instead. A help control therefore never turns
 * into a button that opens nothing. The reads are the ones the panel makes
 * next, so they cost nothing more.
 */
export async function openHelp(link: DocsLink): Promise<void> {
  const target = helpTarget(link);
  try {
    const manifest = await helpApi.getManifest();
    if (!manifest.available) throw new Error('The guide is not bundled');
    await helpApi.getPage(target.page);
  } catch {
    window.open(docsUrl(link), '_blank', 'noopener,noreferrer');
    return;
  }
  useHelpStore.getState().openAt(target);
}

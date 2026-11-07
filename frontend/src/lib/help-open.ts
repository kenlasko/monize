import { useEffect, type MouseEvent } from 'react';
import { helpTarget, type DocsLink } from '@/lib/docs-links';
import { helpApi } from '@/lib/help';
import { useHelpStore } from '@/store/helpStore';

/**
 * Learn, ahead of any click, whether the server has a bundled guide. The read
 * is the one the panel would make anyway and is deduplicated and cached by
 * `helpApi`; a failure is swallowed and leaves the answer unknown, so the next
 * mount or click asks again.
 */
export function prefetchHelp(): void {
  if (useHelpStore.getState().guideAvailable !== null) return;
  // Started from a promise so that nothing about the read, even a throw before
  // it returns a promise, can escape into the render of every page that has a
  // help control.
  Promise.resolve()
    .then(() => helpApi.getManifest())
    .then(
      (manifest) => useHelpStore.getState().setGuideAvailable(manifest.available),
      () => {
        // Unknown stays unknown: the control keeps its link to monize.net.
      },
    );
}

/** Call from every component that renders a help control, `enabled` while it does. */
export function useHelpPrefetch(enabled = true): void {
  useEffect(() => {
    if (enabled) prefetchHelp();
  }, [enabled]);
}

/**
 * The click handler of a help control that is an anchor to the same page on
 * monize.net (`docsUrl(link)`, `target="_blank"`).
 *
 * The choice is made synchronously, inside the click, because a popup blocker
 * only lets a new tab open while the click's user activation is alive and an
 * `await` ends it. When the guide is known to be bundled, the click is taken
 * over and the panel opens at once (the panel loads the page itself and offers
 * "Open on monize.net" if that fails). In every other case -- the manifest has
 * not arrived, said the guide is not bundled, or could not be read -- the event
 * is left alone and the browser follows the anchor natively, which no blocker
 * stops. A modified click (new tab, copy link, middle button) is always the
 * browser's.
 */
export function onHelpLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  link: DocsLink,
): void {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  if (useHelpStore.getState().guideAvailable === true) {
    event.preventDefault();
    useHelpStore.getState().openAt(helpTarget(link));
    return;
  }
  // Not known yet (or unreadable): let the anchor navigate, and ask again so
  // the next click can open the panel.
  prefetchHelp();
}

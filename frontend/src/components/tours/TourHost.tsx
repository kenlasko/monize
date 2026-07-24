'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/authStore';
import { useTourStore } from '@/store/tourStore';
import { toursApi } from '@/lib/tours-api';
import { createLogger } from '@/lib/logger';
import { findTourAnchor } from '@/lib/tours/anchors';
import { useTourAnchor } from '@/hooks/useTourAnchor';
import { useAnchorRect } from '@/hooks/useAnchorRect';
import { TourSpotlight } from './TourSpotlight';
import { TourTooltip } from './TourTooltip';

const logger = createLogger('Tours');

const DEFAULT_ANCHOR_TIMEOUT = 5000;
const POST_NAV_ANCHOR_TIMEOUT = 10000;
/** Interactive appear-waits should not auto-skip; the user drives them. */
const INTERACTIVE_TIMEOUT = 600000;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Drives an active guided tour: navigates to each step's screen, waits for its
 * anchor, renders the spotlight + tooltip, and handles interactive advancement,
 * graceful skips, and dismissal. Mounted once in the root layout beside
 * WhatsNewHost. All transitions run through the tourStore (event/effect
 * callbacks), never component setState in effects.
 */
export function TourHost() {
  const t = useTranslations('tours');
  const pathname = usePathname();
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const active = useTourStore((s) => s.active);
  const progressLoaded = useTourStore((s) => s.progressLoaded);
  const setProgress = useTourStore((s) => s.setProgress);
  const setPhase = useTourStore((s) => s.setPhase);
  const setExpectedRoute = useTourStore((s) => s.setExpectedRoute);
  const next = useTourStore((s) => s.next);
  const back = useTourStore((s) => s.back);
  const skip = useTourStore((s) => s.skip);
  const finish = useTourStore((s) => s.finish);
  const endTour = useTourStore((s) => s.endTour);

  const showingOutro = active?.showSkippedOutro ?? false;
  const step = active && !showingOutro ? active.steps[active.stepIndex] : null;

  // --- Anchor resolution for the current step ---------------------------------
  const navigated = !!step && active?.expectedRoute === step.route;
  const anchorTimeout =
    step?.anchorTimeoutMs ??
    (navigated ? POST_NAV_ANCHOR_TIMEOUT : DEFAULT_ANCHOR_TIMEOUT);
  const anchorEnabled =
    !!active &&
    !showingOutro &&
    (active.phase === 'waiting-anchor' || active.phase === 'active');
  const { element: anchorElement, status: anchorStatus } = useTourAnchor(
    step?.anchorId ?? null,
    { enabled: anchorEnabled, timeoutMs: anchorTimeout },
  );
  const anchorRect = useAnchorRect(anchorElement);

  // --- Interactive appear target ---------------------------------------------
  const appearId =
    active && !showingOutro && active.phase === 'active' && step?.advance?.type === 'appear'
      ? step.advance.anchorId
      : null;
  const { status: appearStatus } = useTourAnchor(appearId, {
    enabled: !!appearId,
    timeoutMs: INTERACTIVE_TIMEOUT,
  });

  const reducedMotion = prefersReducedMotion();

  // Load progress once when authenticated.
  useEffect(() => {
    if (!isAuthenticated || progressLoaded) return;
    let cancelled = false;
    toursApi
      .getProgress()
      .then((progress) => {
        if (!cancelled) setProgress(progress);
      })
      .catch(logger.debug);
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, progressLoaded, setProgress]);

  // Navigate to the step's route, then move on to waiting for its anchor.
  useEffect(() => {
    if (!active || showingOutro || active.phase !== 'navigating') return;
    const s = active.steps[active.stepIndex];
    const onRoute = s.routeMatch
      ? pathname.startsWith(s.routeMatch)
      : pathname === s.route;
    if (onRoute) {
      setPhase('waiting-anchor');
      return;
    }
    if (active.expectedRoute !== s.route) {
      setExpectedRoute(s.route);
      router.push(s.route);
    }
  }, [active, showingOutro, pathname, router, setPhase, setExpectedRoute]);

  // Anchor found -> show it; timed out -> gracefully skip the step.
  useEffect(() => {
    if (!active || showingOutro || active.phase !== 'waiting-anchor') return;
    if (anchorStatus === 'found') setPhase('active');
    else if (anchorStatus === 'timeout') skip();
  }, [active, showingOutro, anchorStatus, setPhase, skip]);

  // Scroll the anchor into view once it is active.
  useEffect(() => {
    if (!active || active.phase !== 'active' || !anchorElement) return;
    anchorElement.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }, [active, anchorElement, reducedMotion]);

  // Interactive advancement: click on the anchor.
  useEffect(() => {
    if (!active || active.phase !== 'active' || !anchorElement) return;
    const s = active.steps[active.stepIndex];
    if (s.advance?.type !== 'click') return;
    const handler = () => next();
    anchorElement.addEventListener('click', handler, { capture: true });
    return () =>
      anchorElement.removeEventListener('click', handler, { capture: true });
  }, [active, anchorElement, next]);

  // Interactive advancement: a target appears (e.g. a form opens).
  useEffect(() => {
    if (appearId && appearStatus === 'found') next();
  }, [appearId, appearStatus, next]);

  // Interactive advancement: a target disappears (e.g. the user closes a form).
  useEffect(() => {
    if (!active || active.phase !== 'active') return;
    const s = active.steps[active.stepIndex];
    if (s.advance?.type !== 'disappear') return;
    const target = s.advance.anchorId;
    let seen = false;
    const check = () => {
      if (findTourAnchor(target)) seen = true;
      else if (seen) {
        cleanup();
        next();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    const interval = setInterval(check, 250);
    const raf = requestAnimationFrame(check);
    function cleanup() {
      observer.disconnect();
      clearInterval(interval);
      cancelAnimationFrame(raf);
    }
    return cleanup;
  }, [active, next]);

  // Interactive advancement: navigation to a matching route.
  useEffect(() => {
    if (!active || active.phase !== 'active') return;
    const s = active.steps[active.stepIndex];
    if (s.advance?.type !== 'route') return;
    const prefix = s.advance.route;
    if (prefix && pathname.startsWith(prefix)) next();
  }, [active, pathname, next]);

  // Unexpected navigation dismisses the tour. Engine-initiated navigation
  // (expectedRoute) and a route-advance step's own target are not "unexpected".
  useEffect(() => {
    if (!active || showingOutro || active.phase === 'navigating') return;
    const s = active.steps[active.stepIndex];
    const onStepRoute = s.routeMatch
      ? pathname.startsWith(s.routeMatch)
      : pathname === s.route;
    const expected =
      !!active.expectedRoute && pathname.startsWith(active.expectedRoute);
    const routeAdvanceTarget =
      s.advance?.type === 'route' &&
      !!s.advance.route &&
      pathname.startsWith(s.advance.route);
    if (onStepRoute || expected || routeAdvanceTarget) return;
    endTour('dismissed');
  }, [active, showingOutro, pathname, endTour]);

  // Esc ends the tour first (capture phase + stopPropagation), so a single Esc
  // during an in-modal step does not also close the form.
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        endTour('dismissed');
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [active, endTour]);

  // --- Render ----------------------------------------------------------------
  if (!active) return null;
  const showOverlay = active.phase === 'active' || showingOutro;
  if (!showOverlay) return null;

  const centered = showingOutro || step?.anchorId == null;
  if (!centered && !anchorRect) return null; // still measuring the anchor rect

  const interactive =
    !showingOutro && !!step?.advance && step.advance.type !== 'next';
  const leaveFocusToForm = !!anchorElement?.closest('[role="dialog"]');
  const isLast = showingOutro || active.stepIndex === active.steps.length - 1;
  const canBack = !showingOutro && active.stepIndex > 0;

  const title = showingOutro
    ? t('controls.skippedTitle')
    : t(`${active.tour.i18nPrefix}.steps.${step!.id}.title`);
  const body = showingOutro
    ? t('controls.skippedBody')
    : t(`${active.tour.i18nPrefix}.steps.${step!.id}.body`);
  const stepLabel = showingOutro
    ? ''
    : t('controls.stepCounter', {
        current: active.stepIndex + 1,
        total: active.steps.length,
      });

  return (
    <>
      <TourSpotlight
        rect={centered ? null : anchorRect}
        interactive={interactive}
        reducedMotion={reducedMotion}
      />
      <TourTooltip
        rect={centered ? null : anchorRect}
        placement={step?.placement}
        title={title}
        body={body}
        stepLabel={stepLabel}
        interactive={interactive}
        isLast={isLast}
        canBack={canBack}
        reducedMotion={reducedMotion}
        leaveFocusToForm={leaveFocusToForm}
        onNext={next}
        onDone={finish}
        onBack={back}
        onSkip={skip}
        onEnd={() => endTour('dismissed')}
        labels={{
          next: t('controls.next'),
          back: t('controls.back'),
          done: t('controls.done'),
          endTour: t('controls.endTour'),
          tryIt: t('controls.tryIt'),
          skipStep: t('controls.skipStep'),
        }}
      />
    </>
  );
}

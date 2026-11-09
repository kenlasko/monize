'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AuthShell } from './AuthShell';
import { OnboardingPreferences } from './OnboardingPreferences';

interface OnboardingPreferencesScreenProps {
  /** See `OnboardingPreferences.onComplete`. */
  onComplete: (result?: { localeChanged: boolean }) => void;
}

/**
 * Full-page framing for the first-run language/currency step, shared by the
 * two paths that reach it: the end of local registration, and the first login
 * of an account an identity provider just provisioned. Both show the same
 * copy, so the strings stay under `auth.register.preferences`.
 */
export function OnboardingPreferencesScreen({
  onComplete,
}: OnboardingPreferencesScreenProps) {
  const t = useTranslations('auth.register.preferences');
  const locale = useLocale();

  return (
    <AuthShell plain title={t('title')} subtitle={t('subtitle')}>
      <OnboardingPreferences initialLanguage={locale} onComplete={onComplete} />
    </AuthShell>
  );
}

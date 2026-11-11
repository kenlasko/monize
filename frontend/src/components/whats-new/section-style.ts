import type { ComponentType, SVGProps } from 'react';
import {
  ArrowsRightLeftIcon,
  ArrowTrendingUpIcon,
  BellIcon,
  BuildingLibraryIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  CurrencyDollarIcon,
  CursorArrowRaysIcon,
  DocumentCheckIcon,
  HeartIcon,
  LanguageIcon,
  PaintBrushIcon,
  QuestionMarkCircleIcon,
  ServerStackIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Squares2X2Icon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import type { ReleaseNoteSection } from '@/lib/whats-new';

type SectionIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface SectionStyle {
  Icon: SectionIcon;
  /** Arbitrary-property class setting `--widget-tint`, read by `TINT_CLASS`. */
  tint: string;
  /**
   * Fixes, operator notes, credits and the like: listed after the feature
   * sections, collapsed and without an icon puck, so the features lead.
   */
  maintenance: boolean;
}

interface Rule {
  match: RegExp;
  Icon: SectionIcon;
  tint: string;
  maintenance?: boolean;
}

const NEUTRAL = '[--widget-tint:var(--chart-neutral)]';

/**
 * Release-notes headings are free text written per release (`docs/release-
 * notes/*.md` has some sixty distinct ones), so a section is classified by
 * keyword and the first rule that matches wins. Maintenance rules come first:
 * "Bug fixes" must not be caught by a feature keyword. Anything unmatched is a
 * feature with the neutral sparkle, so a new heading never breaks the dialog.
 */
const RULES: readonly Rule[] = [
  { match: /\bfix(es)?\b|\bbugs?\b/i, Icon: WrenchScrewdriverIcon, tint: NEUTRAL, maintenance: true },
  { match: /operator|under the hood|tests?\b|quality|what's changed/i, Icon: ServerStackIcon, tint: NEUTRAL, maintenance: true },
  { match: /^credits?$/i, Icon: HeartIcon, tint: NEUTRAL, maintenance: true },
  { match: /crypto|currenc|exchange rate/i, Icon: CurrencyDollarIcon, tint: '[--widget-tint:var(--chart-3)]' },
  { match: /help|guide|documentation/i, Icon: QuestionMarkCircleIcon, tint: '[--widget-tint:var(--chart-primary)]' },
  { match: /dashboard/i, Icon: Squares2X2Icon, tint: '[--widget-tint:var(--chart-7)]' },
  { match: /getting around|navigation/i, Icon: CursorArrowRaysIcon, tint: '[--widget-tint:var(--chart-4)]' },
  { match: /look and feel|interface|polish|theme/i, Icon: PaintBrushIcon, tint: '[--widget-tint:var(--chart-6)]' },
  { match: /bill|deposit|loan|mortgage|scheduled/i, Icon: CalendarDaysIcon, tint: '[--widget-tint:var(--chart-2)]' },
  { match: /invest|securit|portfolio/i, Icon: ArrowTrendingUpIcon, tint: '[--widget-tint:var(--chart-5)]' },
  { match: /report/i, Icon: ChartBarIcon, tint: '[--widget-tint:var(--chart-8)]' },
  { match: /\bai\b|assistant|mcp/i, Icon: ChatBubbleLeftRightIcon, tint: '[--widget-tint:var(--chart-9)]' },
  { match: /shar(ed|ing)/i, Icon: UsersIcon, tint: '[--widget-tint:var(--chart-4)]' },
  { match: /transaction|transfer|register|import|payee|rule/i, Icon: ArrowsRightLeftIcon, tint: '[--widget-tint:var(--chart-primary)]' },
  { match: /account/i, Icon: BuildingLibraryIcon, tint: '[--widget-tint:var(--chart-primary)]' },
  { match: /security|sign-in|backup/i, Icon: ShieldCheckIcon, tint: '[--widget-tint:var(--chart-5)]' },
  { match: /notification|email/i, Icon: BellIcon, tint: '[--widget-tint:var(--chart-3)]' },
  { match: /language/i, Icon: LanguageIcon, tint: '[--widget-tint:var(--chart-10)]' },
  { match: /warrant/i, Icon: DocumentCheckIcon, tint: '[--widget-tint:var(--chart-2)]' },
];

const DEFAULT_STYLE: SectionStyle = {
  Icon: SparklesIcon,
  tint: NEUTRAL,
  maintenance: false,
};

export function sectionStyle(heading: string): SectionStyle {
  const rule = RULES.find((r) => r.match.test(heading));
  if (!rule) return DEFAULT_STYLE;
  return { Icon: rule.Icon, tint: rule.tint, maintenance: rule.maintenance ?? false };
}

const TOP_LEVEL_ITEM_RE = /^[-*+]\s/;

/**
 * How many changes a section lists: its top-level bullets plus its
 * subsections. Nested bullets are detail of the bullet above them, not changes
 * of their own. `0` means the section is prose only, and the count is not shown.
 */
export function countChanges(section: ReleaseNoteSection): number {
  const bullets = section.body
    .split('\n')
    .filter((line) => TOP_LEVEL_ITEM_RE.test(line)).length;
  return bullets + section.children.length;
}

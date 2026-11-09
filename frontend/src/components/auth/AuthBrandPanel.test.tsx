import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Cookies from 'js-cookie';
import { render, screen, act } from '@/test/render';
import enAuth from '@/i18n/messages/en/auth.json';
import { AuthBrandPanel, AUTH_BRAND_SLIDE_COOKIE, AUTH_BRAND_SLIDES } from './AuthBrandPanel';

const slideTitle = (i: number) => enAuth.brandPanel.slides[AUTH_BRAND_SLIDES[i].id].title;

let clock = Date.now();
/** Long enough that the next panel is a new visit, not a screen of the same one. */
const laterVisit = () => vi.setSystemTime((clock += 60_000));

async function visit() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AuthBrandPanel />);
  });
  return view;
}

describe('AuthBrandPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    laterVisit();
    Cookies.remove(AUTH_BRAND_SLIDE_COOKIE);
  });

  afterEach(() => vi.useRealTimers());

  it('opens on the first slide for a browser that has seen none', async () => {
    await visit();
    expect(screen.getByText(slideTitle(0))).toBeInTheDocument();
  });

  it('shows a different slide on each visit, and comes back round', async () => {
    const seen: string[] = [];
    for (let i = 0; i <= AUTH_BRAND_SLIDES.length; i += 1) {
      const view = await visit();
      seen.push(view.getByTestId('auth-brand-panel').textContent ?? '');
      view.unmount();
      laterVisit();
    }
    expect(new Set(seen).size).toBe(AUTH_BRAND_SLIDES.length);
    expect(seen.at(-1)).toBe(seen[0]);
  });

  it('keeps the slide when one visit swaps screens, as register does into first-run setup', async () => {
    const first = await visit();
    const before = first.getByTestId('auth-brand-panel').textContent;
    first.unmount();
    const second = await visit();
    expect(second.getByTestId('auth-brand-panel').textContent).toBe(before);
  });

  it.each(['junk', '-1'])('starts over on an unusable cookie (%s)', async (value) => {
    Cookies.set(AUTH_BRAND_SLIDE_COOKIE, value);
    await visit();
    expect(screen.getByText(slideTitle(0))).toBeInTheDocument();
  });

  it('wraps a remembered index that is past the end after the list shrank', async () => {
    Cookies.set(AUTH_BRAND_SLIDE_COOKIE, String(AUTH_BRAND_SLIDES.length * 2 + 1));
    await visit();
    expect(screen.getByTestId('auth-brand-panel')).toBeInTheDocument();
  });

  it('bounds the picture by the panel, so a narrow window scales it instead of cropping it', async () => {
    await visit();
    for (const variant of ['', '.light']) {
      const shot = screen.getByTestId(`auth-brand-shot-dashboard-overview${variant}`);
      expect(shot.className).toContain('max-w-full');
      expect(shot.className).toContain('max-h-full');
      expect(shot.className).not.toContain('max-w-none');
    }
  });

  it('names the same pictures as the script that builds them', () => {
    const script = readFileSync(resolve(process.cwd(), 'scripts/build-brand-screenshots.mjs'), 'utf8');
    const names = [...(script.match(/const NAMES = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual(AUTH_BRAND_SLIDES.map((slide) => slide.image));
  });

  it('has a picture on disk for every slide in both modes', () => {
    for (const { image } of AUTH_BRAND_SLIDES) {
      for (const variant of ['', '.light']) {
        expect(existsSync(resolve(process.cwd(), `public/brand/${image}${variant}.webp`))).toBe(true);
      }
    }
  });
});

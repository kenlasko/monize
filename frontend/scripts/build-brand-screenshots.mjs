#!/usr/bin/env node
// Builds the pictures on the auth screens' brand panel (public/brand/) from
// the documentation screenshots, at login-page weight. Run it from frontend/
// after retaking any of the screens named below.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'website', 'docs', 'images');
const target = join(root, 'public', 'brand');
// Keep in step with AUTH_BRAND_SLIDES; AuthBrandPanel.test.tsx checks the files.
const NAMES = [
  'dashboard-overview',
  'transactions-page',
  'investments-page',
  'bills-calendar',
  'budgets-page',
  'reports-page',
];

mkdirSync(target, { recursive: true });
for (const name of NAMES) {
  for (const variant of ['', '.light']) {
    await sharp(join(source, `${name}${variant}.png`))
      .resize({ width: 1400 })
      .webp({ quality: 78 })
      .toFile(join(target, `${name}${variant}.webp`));
  }
}

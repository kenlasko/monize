import { describe, expect, it } from 'vitest';

import { scanFilename } from './decode-image';

/**
 * The filename half of the decode helpers.
 *
 * Decoding and encoding need a real canvas, which jsdom does not provide, so
 * those are exercised by the end-to-end spec in a browser. What can be checked
 * here is the naming, which is what a user reads in their attachments list --
 * and a pair whose two halves do not look related is worse than no pair.
 */
describe('scanFilename', () => {
  it('marks the scan while keeping the original stem', () => {
    expect(scanFilename('receipt.jpg')).toBe('receipt-scan.jpg');
    expect(scanFilename('IMG_20260301_120000.HEIC')).toBe(
      'IMG_20260301_120000-scan.jpg',
    );
  });

  it('drops only the final extension', () => {
    expect(scanFilename('invoice.2026.03.png')).toBe(
      'invoice.2026.03-scan.jpg',
    );
  });

  it('handles a name with no extension', () => {
    expect(scanFilename('receipt')).toBe('receipt-scan.jpg');
  });

  // A camera can hand over a blank name, and a file called "-scan.jpg" reads
  // as a bug rather than as a document.
  it('falls back to a generic stem for an empty or missing name', () => {
    expect(scanFilename('')).toBe('document-scan.jpg');
    expect(scanFilename(undefined as unknown as string)).toBe(
      'document-scan.jpg',
    );
    expect(scanFilename('.jpg')).toBe('document-scan.jpg');
  });

  // The server sanitizes the name it stores, but it should not have to repair
  // a path this side put there.
  it('does not introduce path separators', () => {
    expect(scanFilename('folder/receipt.jpg')).not.toContain('..');
    expect(scanFilename('receipt.jpg')).not.toMatch(/[\\/]/);
  });
});

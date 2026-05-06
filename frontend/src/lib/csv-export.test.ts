import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportToCsv } from './csv-export';

describe('exportToCsv', () => {
  let createObjectURL: any;
  let revokeObjectURL: any;
  let appendChild: any;
  let removeChild: any;
  let clickSpy: any;
  let createElementSpy: any;
  let lastLink: HTMLAnchorElement | null;

  beforeEach(() => {
    lastLink = null;
    createObjectURL = vi.fn().mockReturnValue('blob:mock');
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });

    appendChild = vi.spyOn(document.body, 'appendChild').mockImplementation((node: any) => {
      lastLink = node;
      // Override click on the anchor element to capture downloads without
      // triggering a real navigation in jsdom.
      if (node && node.tagName === 'A') {
        (node as HTMLAnchorElement).click = clickSpy;
      }
      return node;
    });
    removeChild = vi.spyOn(document.body, 'removeChild').mockImplementation((node: any) => node);
    clickSpy = vi.fn();
    createElementSpy = vi.fn();
  });

  it('creates a csv blob with given headers and rows and triggers download', () => {
    exportToCsv('report', ['Name', 'Amount'], [
      ['Apple', 10],
      ['Banana', 20],
    ]);

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(lastLink?.download).toBe('report.csv');
  });

  it('does not double the .csv extension', () => {
    exportToCsv('report.csv', ['A'], [['1']]);
    expect(lastLink?.download).toBe('report.csv');
  });

  it('escapes values containing commas', () => {
    exportToCsv('out', ['Name'], [['hello, world']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"hello, world"');
    });
  });

  it('escapes values containing quotes by doubling them', () => {
    exportToCsv('out', ['Name'], [['quote "here"']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"quote ""here"""');
    });
  });

  it('handles values with newlines', () => {
    exportToCsv('out', ['Name'], [['line1\nline2']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('"line1\nline2"');
    });
  });

  it('handles null and undefined as empty strings', () => {
    exportToCsv('out', ['A', 'B'], [[null, undefined]]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('A,B');
      expect(text).toContain('\r\n,');
    });
  });

  it('prevents formula injection by prefixing dangerous characters with tab', () => {
    exportToCsv('out', ['F'], [['=cmd|run']]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      // Tab prefix forces it to be a quoted value (since tab is dangerous char list)
      expect(text).toContain('\t=cmd|run');
    });
  });

  it('handles boolean and number values', () => {
    exportToCsv('out', ['A', 'B'], [[true, 42]]);
    const blobArg = (createObjectURL.mock.calls[0][0] as Blob);
    return blobArg.text().then((text) => {
      expect(text).toContain('true,42');
    });
  });
});

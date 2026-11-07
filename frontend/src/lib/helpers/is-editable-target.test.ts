import { describe, it, expect } from 'vitest';
import { isEditableTarget } from './is-editable-target';

describe('isEditableTarget', () => {
  it.each(['input', 'textarea', 'select'])('is true for a %s element', (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true);
  });

  it('is true for a contenteditable element', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.append(div);
    expect(isEditableTarget(div)).toBe(true);
    div.remove();
  });

  it('is true for contenteditable="plaintext-only"', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'plaintext-only');
    document.body.append(div);
    expect(isEditableTarget(div)).toBe(true);
    div.remove();
  });

  it('is true for a plain child of a contenteditable ancestor', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.append(child);
    document.body.append(editable);
    expect(isEditableTarget(child)).toBe(true);
    editable.remove();
  });

  it('is false inside a contenteditable="false" region nested in an editable ancestor', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const chip = document.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    const chipText = document.createElement('b');
    chip.append(chipText);
    editable.append(chip);
    document.body.append(editable);
    expect(isEditableTarget(chip)).toBe(false);
    expect(isEditableTarget(chipText)).toBe(false);
    editable.remove();
  });

  it('is false for a button or a div', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('is false for null and a non-element target', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

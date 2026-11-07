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

  it('is false for a button or a div', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });

  it('is false for null and a non-element target', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { discardChatHandoff, peekChatHandoff, stageChatHandoff } from './ai-chat-handoff';

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });

describe('ai-chat-handoff', () => {
  it('parks content under a random UUID and reads it without taking it', () => {
    const handoff = { files: [file('a.txt')], draft: 'hello' };
    const id = stageChatHandoff(handoff);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(peekChatHandoff(id)).toBe(handoff);
    expect(peekChatHandoff(id)).toBe(handoff);
  });

  it('gives a different id to every hand-off', () => {
    expect(stageChatHandoff({ files: [], draft: '' })).not.toBe(stageChatHandoff({ files: [], draft: '' }));
  });

  it('forgets an entry once it is discarded, and discarding twice is harmless', () => {
    const id = stageChatHandoff({ files: [], draft: 'x' });
    discardChatHandoff(id);
    discardChatHandoff(id);
    expect(peekChatHandoff(id)).toBeNull();
  });

  it.each([null, undefined, '', 'not-an-id'])('reads nothing for %p', (id) => {
    expect(peekChatHandoff(id)).toBeNull();
    expect(() => discardChatHandoff(id)).not.toThrow();
  });

  it('keeps only the newest few, so an uncollected hand-off cannot pile up', () => {
    const first = stageChatHandoff({ files: [], draft: '1' });
    const later = Array.from({ length: 5 }, (_, i) => stageChatHandoff({ files: [], draft: String(i) }));
    expect(peekChatHandoff(first)).toBeNull();
    expect(later.every((id) => peekChatHandoff(id) !== null)).toBe(true);
  });

  it('is memory only: nothing reaches browser storage', () => {
    stageChatHandoff({ files: [], draft: 'secret order email' });
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('secret order email');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('secret order email');
  });
});

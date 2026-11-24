import { describe, it, expect } from 'vitest';
import { createLatestSaveTracker } from './latest-save';

describe('createLatestSaveTracker', () => {
  it('adopts the latest reply and holds back an earlier one landing after it', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(second.succeeded('b')).toEqual({ adopt: 'b', isLatest: true });
    expect(first.succeeded('a')).toEqual({ adopt: null, isLatest: false });
  });

  it('holds an earlier success while the latest is in flight', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(first.succeeded('a')).toEqual({ adopt: null, isLatest: false });
    expect(second.succeeded('b')).toEqual({ adopt: 'b', isLatest: true });
  });

  it('adopts the earlier success once the latest fails after it', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(first.succeeded('a')).toEqual({ adopt: null, isLatest: false });
    expect(second.failed()).toEqual({ adopt: 'a', isLatest: true });
  });

  it('adopts an earlier success that lands after the latest has failed', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    const second = tracker.begin();
    expect(second.failed()).toEqual({ adopt: null, isLatest: true });
    expect(first.succeeded('a')).toEqual({ adopt: 'a', isLatest: false });
  });

  it('keeps the newest of several earlier successes', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    const second = tracker.begin();
    const third = tracker.begin();
    second.succeeded('b');
    first.succeeded('a');
    expect(third.failed()).toEqual({ adopt: 'b', isLatest: true });
    // An older success after that cannot take the store back further.
    expect(first.succeeded('a')).toEqual({ adopt: null, isLatest: false });
  });

  it('reports an earlier failure to nobody', () => {
    const tracker = createLatestSaveTracker<string>();
    const first = tracker.begin();
    tracker.begin();
    expect(first.failed()).toEqual({ adopt: null, isLatest: false });
  });
});

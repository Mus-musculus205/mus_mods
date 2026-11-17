// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopPage, PlacedItem } from '../../../registry/widgets/layout';
import {
  addPageAtEnd, canAddPageAtEnd, createSnapRestorer, edgeTurnDirection, indexAfterInsert, indexAfterRemove, pickSwipeTargetPage,
} from './launcherPaging';

const release = (dx: number, durationMs: number, startPage = 1) =>
  pickSwipeTargetPage({ startPage, dx, durationMs, pageWidth: 400, pageCount: 3 });

describe('pickSwipeTargetPage', () => {
  it('turns on a short fast flick that never crosses half the page', () => {
    expect(release(-60, 100)).toBe(2);
    expect(release(60, 100)).toBe(0);
  });

  it('turns on a slow drag past a fifth of the page', () => {
    expect(release(-90, 1500)).toBe(2);
    expect(release(90, 1500)).toBe(0);
  });

  it('stays on a slow short drag', () => {
    expect(release(-40, 1500)).toBe(1);
  });

  it('clamps at the first and last page', () => {
    expect(release(-200, 100, 2)).toBe(2);
    expect(release(200, 100, 0)).toBe(0);
  });
});

const item = (id: string): PlacedItem => ({ id, kind: 'app', refId: id, x: 0, y: 0, w: 1, h: 1 });
const page = (id: string, items: PlacedItem[]): DesktopPage => ({ id, items } as DesktopPage);

describe('adding a page at either end while dragging', () => {
  const pages = [page('a', [item('x')]), page('m', [item('m1')]), page('b', [item('y'), item('z')])];

  it('adds only from the page at that end, the same way on both sides', () => {
    expect(canAddPageAtEnd(pages, 2, 1)).toBe(true);
    expect(canAddPageAtEnd(pages, 0, -1)).toBe(true);
    expect(canAddPageAtEnd(pages, 1, 1)).toBe(false);
    expect(canAddPageAtEnd(pages, 1, -1)).toBe(false);
  });

  it('adds even when the dragged item is the only one there, but not past an empty end page', () => {
    expect(canAddPageAtEnd([page('a', [item('x')]), page('b', [item('y')])], 1, 1)).toBe(true);
    expect(canAddPageAtEnd([page('a', []), page('b', [])], 1, 1)).toBe(false);
    expect(canAddPageAtEnd([page('a', []), page('b', [])], 0, -1)).toBe(false);
  });

  it('inserts at the end for right and at the front for left', () => {
    const fresh = page('new', []);
    const right = addPageAtEnd(pages, fresh, 1);
    expect(right.index).toBe(3);
    expect(right.pages.map(pg => pg.id)).toEqual(['a', 'm', 'b', 'new']);
    const left = addPageAtEnd(pages, fresh, -1);
    expect(left.index).toBe(0);
    expect(left.pages.map(pg => pg.id)).toEqual(['new', 'a', 'm', 'b']);
  });

  it('maps page numbers across an insert and a removal', () => {
    expect(indexAfterInsert(2, 0)).toBe(3);
    expect(indexAfterInsert(2, 3)).toBe(2);
    expect(indexAfterRemove(3, 0, 3)).toBe(2);
    expect(indexAfterRemove(1, 3, 3)).toBe(1);
    expect(indexAfterRemove(3, 3, 3)).toBe(2);
    expect(indexAfterRemove(0, 0, 3)).toBe(0);
  });
});

describe('createSnapRestorer', () => {
  afterEach(() => vi.useRealTimers());

  it('restores snap after the fallback when no scrollend arrives', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    const snap = createSnapRestorer();
    snap.suspend(el);
    snap.restoreAfterScroll(el, 420);
    expect(el.style.scrollSnapType).toBe('none');
    vi.advanceTimersByTime(420);
    expect(el.style.scrollSnapType).toBe('x mandatory');
  });

  it('a new gesture cancels the previous pending restore', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    const snap = createSnapRestorer();
    snap.suspend(el);
    snap.restoreAfterScroll(el, 420);
    vi.advanceTimersByTime(200);
    snap.suspend(el); // next swipe starts before the first restore ran
    vi.advanceTimersByTime(1000);
    el.dispatchEvent(new Event('scrollend'));
    expect(el.style.scrollSnapType).toBe('none');
  });

  it('restores on scrollend and does not fire again later', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    const snap = createSnapRestorer();
    snap.suspend(el);
    snap.restoreAfterScroll(el, 420);
    el.dispatchEvent(new Event('scrollend'));
    expect(el.style.scrollSnapType).toBe('x mandatory');
    el.style.scrollSnapType = 'none';
    vi.advanceTimersByTime(1000);
    expect(el.style.scrollSnapType).toBe('none');
  });
});

describe('edgeTurnDirection', () => {
  const root = { left: 0, right: 375, width: 375 };
  const ghostAt = (left: number, width = 76) => ({ left, right: left + width, width });

  it('uses the same rule on both sides', () => {
    expect(edgeTurnDirection(20, root, ghostAt(100))).toBe(-1);
    expect(edgeTurnDirection(355, root, ghostAt(100))).toBe(1);
    expect(edgeTurnDirection(80, root, ghostAt(4))).toBe(-1);
    expect(edgeTurnDirection(295, root, ghostAt(295))).toBe(1);
    expect(edgeTurnDirection(187, root, ghostAt(150))).toBe(0);
  });

  it('ignores the ghost of a wide widget that touches both edges', () => {
    expect(edgeTurnDirection(187, root, ghostAt(0, 375))).toBe(0);
    expect(edgeTurnDirection(360, root, ghostAt(0, 375))).toBe(1);
    expect(edgeTurnDirection(10, root, ghostAt(0, 375))).toBe(-1);
  });

  it('keeps an armed side through jitter at the zone boundary, the same on both sides', () => {
    expect(edgeTurnDirection(53, root, ghostAt(150))).toBe(0);
    expect(edgeTurnDirection(53, root, ghostAt(150), -1)).toBe(-1);
    expect(edgeTurnDirection(322, root, ghostAt(150), 1)).toBe(1);
    expect(edgeTurnDirection(322, root, ghostAt(150))).toBe(0);
    expect(edgeTurnDirection(100, root, ghostAt(150), -1)).toBe(0);
  });
});

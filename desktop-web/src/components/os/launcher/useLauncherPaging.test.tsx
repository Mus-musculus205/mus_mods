// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { emptyPage } from '../../../utils/desktopGrid';
import { useLauncherPaging } from './useLauncherPaging';

it('loads the configured start page and lets a new swipe interrupt an animated turn', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });

  const container = document.createElement('div');
  const scroller = document.createElement('div');
  Object.defineProperties(scroller, {
    clientWidth: { value: 400 },
    scrollWidth: { value: 1200 },
  });
  scroller.scrollTo = options => {
    if (typeof options === 'object') scroller.scrollLeft = options.left ?? 0;
  };

  let paging: ReturnType<typeof useLauncherPaging>;
  const pages = [emptyPage('a'), { ...emptyPage('home'), layout: 'home' as const }, emptyPage('c')];
  function Probe({ isDataLoaded }: { isDataLoaded: boolean }) {
    paging = useLauncherPaging({
      pagesRef: useRef(pages),
      scrollContainerRef: useRef(scroller),
      startPageId: 'a',
      isDataLoaded,
      onScroll: () => {},
      onScrollPageChange: () => {},
    });
    return null;
  }

  const root = createRoot(container);
  try {
    act(() => root.render(<Probe isDataLoaded={false} />));
    act(() => { vi.advanceTimersByTime(40); });
    expect(paging!.initialScrollDone).toBe(false);
    expect(scroller.scrollLeft).toBe(400);

    act(() => root.render(<Probe isDataLoaded />));
    act(() => { vi.advanceTimersByTime(40); });
    expect(paging!.initialScrollDone).toBe(true);
    expect(paging!.activePageIndex).toBe(0);
    expect(scroller.scrollLeft).toBe(0);

    act(() => paging.scrollToPage(2));
    expect(paging!.activePageIndex).toBe(2);
    expect(scroller.style.scrollSnapType).toBe('none');

    act(() => {
      paging.beginPageSwipe();
      scroller.scrollLeft = 60;
      expect(paging.finishSwipe(0, -60, 100)).toBe(1);
      paging.handleScroll();
      scroller.dispatchEvent(new Event('scrollend'));
      vi.advanceTimersByTime(500);
    });
    expect(paging!.activePageIndex).toBe(1);
    expect(scroller.scrollLeft).toBe(400);
    expect(scroller.style.scrollSnapType).toBe('x mandatory');

    scroller.style.overflowX = 'auto';
    const releaseNativePan = paging!.lockNativePan();
    expect(scroller.style.overflowX).toBe('hidden');
    act(() => paging.scrollToPage(2, 'auto'));
    expect(scroller.scrollLeft).toBe(800);
    releaseNativePan?.();
    expect(scroller.style.overflowX).toBe('auto');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

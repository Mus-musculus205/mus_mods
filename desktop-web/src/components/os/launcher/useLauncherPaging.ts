import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import type { DesktopPage } from '../../../registry/widgets/layout';
import { findHomeIndex } from '../../../utils/desktopGrid';
import { createSnapRestorer, pickSwipeTargetPage } from './launcherPaging';

const PAGE_SCROLL_MS = 300;
const SNAP_RESTORE_FALLBACK_MS = 420;

// 从 App 返回时回到上次浏览的桌面页；首次挂载按已配置的起始页定位。
let lastPageIndex = -1;

interface LauncherPagingOptions {
  pagesRef: MutableRefObject<DesktopPage[]>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  startPageId?: string;
  isDataLoaded: boolean;
  onScroll: () => void;
  onScrollPageChange: () => void;
}

export function useLauncherPaging({
  pagesRef, scrollContainerRef, startPageId, isDataLoaded, onScroll, onScrollPageChange,
}: LauncherPagingOptions) {
  const [activePageIndex, setActivePageIndex] = useState(() => Math.max(0, lastPageIndex));
  const activePageIndexRef = useRef(activePageIndex);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const initialScrollDoneRef = useRef(false);
  const [snapRestorer] = useState(createSnapRestorer);
  const animation = useRef<{ frame: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  const setCurrentPage = useCallback((index: number) => {
    activePageIndexRef.current = index;
    lastPageIndex = index;
    setActivePageIndex(index);
  }, []);

  // 初始定位：本次会话首次挂载（lastPageIndex < 0）用 launcherStartPageId 定起始页
  // （未设置 = 主屏，不管主屏现在被挪到第几页）；从 App 返回则回上次浏览页。
  // 定位完成前忽略 onScroll，免得容器刚挂载时 scrollLeft=0 触发的那次事件把落点
  // 覆盖成第一页。
  //
  // 这里按当时的 el.clientWidth 算 scrollLeft 只是「第一次」定位，还不算完事：
  // 外壳（PhoneShell）挂载后经常还会有一次视口宽度收缩（铺满窗口 → 收成手机画幅），
  // 这次收缩发生在这段定位逻辑跑完*之后*，会让刚刚按旧宽度算好的绝对像素值
  // 对不上收缩后的新页宽——实测复现过好几次「明明该停在主屏却停在第 0 页」。
  // 用 ResizeObserver 盯着容器宽度：用户还没自己动过手（interacted）之前，
  // 宽度一变就按当前目标页重新贴一次 scrollLeft；用户一旦自己滑动/长按过，
  // 就再也不插手，避免和用户手势打架。8 秒超时兜底，防止某些设备上宽度
  // 一直抖动导致纠正逻辑永远不退出。
  useLayoutEffect(() => {
    if (initialScrollDoneRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const pgs = pagesRef.current;
    let target: number;
    if (lastPageIndex >= 0) {
      target = lastPageIndex;
    } else if (isDataLoaded) {
      const idx = startPageId
        ? pgs.findIndex(p => p.id === startPageId)
        : -1;
      target = idx >= 0 ? idx : findHomeIndex(pgs);
      lastPageIndex = target;
    } else {
      target = findHomeIndex(pgs);
    }
    target = Math.max(0, Math.min(pgs.length - 1, target));

    activePageIndexRef.current = target;
    setActivePageIndex(target);

    let settledCount = 0;
    let rafId = 0;
    let interacted = false;

    const markDone = () => {
      if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        setInitialScrollDone(true);
      }
    };

    const markInteracted = () => {
      interacted = true;
      markDone();
    };
    el.addEventListener('pointerdown', markInteracted, { once: true });

    const settle = () => {
      if (interacted) return;
      const clientW = el.clientWidth;
      const scrollW = el.scrollWidth;
      // 容器子页面尚未展开时，直接跳过等下一帧
      if (target > 0 && scrollW <= clientW) return;

      const want = clientW * target;
      if (Math.abs(el.scrollLeft - want) > 1) {
        el.scrollLeft = want;
        settledCount = 0;
      } else {
        settledCount++;
        // 稳定对齐连续 2 帧，且如果数据已经就绪（或从 App 返回），完成初始定位！
        if (settledCount >= 2 && (lastPageIndex >= 0 || isDataLoaded)) {
          markDone();
        }
      }
    };

    settle();
    const tick = () => {
      settle();
      if (!interacted && !initialScrollDoneRef.current) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);

    const ro = new ResizeObserver(settle);
    ro.observe(el);

    const stopTimer = setTimeout(() => {
      markDone();
      ro.disconnect();
    }, 8000);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(stopTimer);
      el.removeEventListener('pointerdown', markInteracted);
    };
  }, [isDataLoaded, startPageId, pagesRef, scrollContainerRef]);

  const stopPageAnimation = useCallback(() => {
    const current = animation.current;
    if (!current) return;
    cancelAnimationFrame(current.frame);
    clearTimeout(current.timer);
    animation.current = null;
  }, []);

  useEffect(() => () => {
    stopPageAnimation();
    snapRestorer.cancel();
  }, [snapRestorer, stopPageAnimation]);

  const beginPageSwipe = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stopPageAnimation();
    snapRestorer.suspend(el);
  };

  const lockNativePan = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // 保留程序化翻页，但拿起条目后不再让浏览器直接滚动这个容器。
    const previousOverflow = el.style.overflowX;
    el.style.overflowX = 'hidden';
    return () => { el.style.overflowX = previousOverflow; };
  };

  const snapToPage = (el: HTMLDivElement, index: number) => {
    el.scrollTo({ left: index * el.clientWidth, behavior: 'smooth' });
    snapRestorer.restoreAfterScroll(el, SNAP_RESTORE_FALLBACK_MS);
  };

  const finishSwipe = (startLeft: number, dx: number, durationMs: number) => {
    const el = scrollContainerRef.current;
    if (!el || !el.clientWidth) return null;
    const target = pickSwipeTargetPage({
      startPage: Math.round(startLeft / el.clientWidth),
      dx,
      durationMs,
      pageWidth: el.clientWidth,
      pageCount: pagesRef.current.length,
    });
    snapToPage(el, target);
    return target;
  };

  const nearestPage = (el: HTMLDivElement) =>
    Math.max(0, Math.min(pagesRef.current.length - 1, Math.round(el.scrollLeft / el.clientWidth)));

  const snapToNearestPage = () => {
    const el = scrollContainerRef.current;
    if (!el || !el.clientWidth) return null;
    const target = nearestPage(el);
    setCurrentPage(target);
    snapToPage(el, target);
    return target;
  };

  // 贴边和点击页码时逐帧写入 scrollLeft，防止拖拽预览重渲染时 CSS snap 把页面吸回原位。
  const scrollToPage = useCallback((target: number, behavior: 'smooth' | 'auto' = 'smooth') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCurrentPage(target);
    stopPageAnimation();
    snapRestorer.suspend(el);
    const from = el.scrollLeft;
    const to = target * el.clientWidth;

    if (behavior === 'auto' || from === to) {
      el.scrollLeft = to;
      snapRestorer.restore(el);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const current = animation.current;
      if (!current) return;
      const t = Math.min(1, (now - start) / PAGE_SCROLL_MS);
      if (t >= 1) return;
      el.scrollLeft = from + (to - from) * (1 - (1 - t) ** 3);
      current.frame = requestAnimationFrame(step);
    };
    animation.current = {
      frame: requestAnimationFrame(step),
      // 切到后台时 rAF 会停，仍要把滚动和吸附收尾。
      timer: setTimeout(() => {
        stopPageAnimation();
        el.scrollLeft = to;
        snapRestorer.restore(el);
      }, PAGE_SCROLL_MS),
    };
  }, [scrollContainerRef, setCurrentPage, snapRestorer, stopPageAnimation]);

  const jumpToPage = useCallback((index: number) => {
    const target = Math.max(0, Math.min(pagesRef.current.length - 1, index));
    if (target !== activePageIndexRef.current) scrollToPage(target);
  }, [pagesRef, scrollToPage]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!initialScrollDoneRef.current || !el || !el.clientWidth) return;
    onScroll();

    // 程序化滚动过程中只有动画本身更新目标页，忽略中间的 scrollLeft。
    if (animation.current) return;
    const index = nearestPage(el);
    if (index === activePageIndexRef.current) return;

    setCurrentPage(index);
    onScrollPageChange();
    try {
      navigator.vibrate?.(10);
    } catch {
      // 触觉反馈取决于平台和浏览器授权。
    }
  };

  return {
    activePageIndex, activePageIndexRef, initialScrollDone, handleScroll,
    setCurrentPage, scrollToPage, jumpToPage, beginPageSwipe, finishSwipe, snapToNearestPage, lockNativePan,
  };
}

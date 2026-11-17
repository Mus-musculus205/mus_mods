// 桌面横向翻页的纯逻辑：松手后停在哪一页、拖到最后一页右边时要不要临时加一页、
// 以及 scroll-snap 的暂停 / 恢复。Launcher.tsx 的鼠标拖动、整理态图标上的手指滑动、
// 双指翻页都走这里，判断只有一份。
import type { DesktopPage } from '../../../registry/widgets/layout';

// 甩动速度（px/ms）或拖动距离（占页宽比例）任一达到就翻到相邻页。
export const SWIPE_FLICK_VELOCITY = 0.35;
export const SWIPE_DISTANCE_RATIO = 0.2;

export interface SwipeRelease {
  startPage: number;
  /** 手指 / 鼠标从按下到松手的横向位移，向左为负。 */
  dx: number;
  durationMs: number;
  pageWidth: number;
  pageCount: number;
}

export const pickSwipeTargetPage = ({ startPage, dx, durationMs, pageWidth, pageCount }: SwipeRelease): number => {
  const velocity = dx / Math.max(1, durationMs);
  if (velocity < -SWIPE_FLICK_VELOCITY || dx < -pageWidth * SWIPE_DISTANCE_RATIO) {
    return Math.min(pageCount - 1, startPage + 1);
  }
  if (velocity > SWIPE_FLICK_VELOCITY || dx > pageWidth * SWIPE_DISTANCE_RATIO) {
    return Math.max(0, startPage - 1);
  }
  return startPage;
};

/**
 * 拖着条目时贴哪边：左右用同一条规则，翻已有的页和在末尾加新页也用这一条。
 * - 手指进了边缘区（屏宽 12%，至少 48px）算贴边；
 * - 拖着的影子碰到屏幕边也算，但只限窄条目（影子不到半屏宽）。宽小组件一拿起
 *   影子就同时碰到左右两边，以前左边先判断，会一直往左翻。
 * 两边同时成立时不翻。
 * 已经在等某一边翻页（armed）时，那一边的边缘区放宽 EDGE_KEEP_PX：手指停在边界上
 * 自然的抖动不会把倒计时一次次清零、永远翻不过去。
 */
export const EDGE_KEEP_PX = 24;

export const edgeTurnDirection = (
  fingerX: number,
  root: { left: number; right: number; width: number },
  ghost: { left: number; right: number; width: number } | null,
  armed: -1 | 0 | 1 = 0,
): -1 | 0 | 1 => {
  const zone = Math.max(48, Math.floor(root.width * 0.12));
  const leftZone = zone + (armed === -1 ? EDGE_KEEP_PX : 0);
  const rightZone = zone + (armed === 1 ? EDGE_KEEP_PX : 0);
  const ghostCounts = !!ghost && ghost.width < root.width / 2;
  const left = fingerX <= root.left + leftZone || (ghostCounts && ghost!.left <= root.left + 8);
  const right = fingerX >= root.right - rightZone || (ghostCounts && ghost!.right >= root.right - 8);
  if (left === right) return 0;
  return left ? -1 : 1;
};

/**
 * 拖着条目贴边、那一头已经没有页了：往右在最后面、往左在最前面临时加一页。
 * 左右是同一套逻辑，只由 dir 决定"那一头"是哪一页、新页插在哪。
 */
const endPageIndex = (pageCount: number, dir: -1 | 1): number => (dir === 1 ? pageCount - 1 : 0);

/**
 * 当前就在拖动方向那一头的页上、且那一页不是空页，才加新页；那一头已经是空页时直接放那页就行。
 * 那一页只剩正在拖的这一个也照样加：拖过去后原页空了会被自动删掉，不会攒出空页，
 * 而且这样才能把一个 App 挪回原来的位置。
 */
export const canAddPageAtEnd = (
  pages: readonly DesktopPage[],
  currentPage: number,
  dir: -1 | 1,
): boolean => {
  const end = endPageIndex(pages.length, dir);
  return currentPage === end && pages[end].items.length > 0;
};

/** 把新页加在拖动方向那一头，返回新页下标。原来下标不小于它的页都往后挪一位（见 indexAfterInsert）。 */
export const addPageAtEnd = (
  pages: readonly DesktopPage[],
  page: DesktopPage,
  dir: -1 | 1,
): { pages: DesktopPage[]; index: number } => {
  const index = dir === 1 ? pages.length : 0;
  return { pages: [...pages.slice(0, index), page, ...pages.slice(index)], index };
};

/** 在 insertedAt 插入一页后，原来第 i 页的新下标。 */
export const indexAfterInsert = (i: number, insertedAt: number): number => (i >= insertedAt ? i + 1 : i);

/** 删掉 removedAt 那一页后，原来第 i 页的新下标；删的就是它时停在原位置（没有就退到最后一页）。 */
export const indexAfterRemove = (i: number, removedAt: number, newCount: number): number =>
  (i > removedAt ? i - 1 : Math.min(i, newCount - 1));

/**
 * 手动写 scrollLeft 跟手时要先关掉 scroll-snap，否则 mandatory 吸附会把每次写入拽回最近一页。
 * 恢复吸附只能有一个在等：新的手势开始时必须取消上一次留下的恢复，
 * 不然它会在这次滑到一半时把吸附打开，页面就卡住不跟手。
 */
export const createSnapRestorer = () => {
  let pending: { el: HTMLElement; timer: ReturnType<typeof setTimeout>; restore: () => void } | null = null;

  const cancel = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.el.removeEventListener('scrollend', pending.restore);
    pending = null;
  };

  const suspend = (el: HTMLElement) => {
    cancel();
    el.style.scrollSnapType = 'none';
  };

  /** 等这次平滑滚动结束再恢复；滚动没真正发生时不会有 scrollend，用超时收尾。 */
  const restoreAfterScroll = (el: HTMLElement, fallbackMs: number) => {
    cancel();
    const restore = () => {
      cancel();
      el.style.scrollSnapType = 'x mandatory';
    };
    el.addEventListener('scrollend', restore, { once: true });
    pending = { el, timer: setTimeout(restore, fallbackMs), restore };
  };

  /** 滚动已经由我们自己停在整页上（如翻页动画走完），直接恢复。 */
  const restore = (el: HTMLElement) => {
    cancel();
    el.style.scrollSnapType = 'x mandatory';
  };

  return { suspend, restoreAfterScroll, restore, cancel };
};

export type SnapRestorer = ReturnType<typeof createSnapRestorer>;

import React, { useMemo, useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { isPaperWallpaper, useOS } from '../context/OSContext';
import { AppID, APP_REGISTRY, getInstalledAppDefinitions, getDefaultDockAppIds, type DesktopAppDefinition } from './registry';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../utils/devDebug';

import type { DesktopLayout, DesktopPage, PlacedItem, GridItemKind, WidgetKind } from '../registry/widgets/layout';
import { ScheduleFullscreenViewer } from '../components/schedule/ScheduleHomeWidget';
import MobileGameHome from '../components/os/MobileGameHome';
import TamagotchiHome from '../components/os/TamagotchiHome';
import { DesktopGalleryModal } from '../components/os/DesktopGalleryModal';
import { QuadAppPickerModal } from '../components/os/QuadAppPickerModal';
import { ImagePickerModal } from '../components/os/ImagePickerModal';
import type { WidgetRenderContext } from '../components/os/desktopWidgetRegistry';
import { getWidgetSizeLimits } from '../registry/widgets';
import { DesktopPageView } from '../components/os/launcher/DesktopPageView';
import type { DesktopDragPreview } from '../components/os/launcher/DesktopGridSurface';
import {
    GRID_COL_GAP,
    GRID_ROW_GAP,
    PAGE_PAD_X,
    cellHeightFor,
} from '../components/os/launcher/launcherGeometry';
import {
    edgeTurnDirection,
    canAddPageAtEnd, addPageAtEnd, indexAfterInsert, indexAfterRemove,
} from '../components/os/launcher/launcherPaging';
import { LauncherDock } from '../components/os/launcher/LauncherDock';
import { PageIndicators } from '../components/os/launcher/PageIndicators';
import { useLauncherPaging } from '../components/os/launcher/useLauncherPaging';
import { useLauncherWidgetData } from '../components/os/launcher/useLauncherWidgetData';
import { createDragGhost } from '../components/os/launcher/launcherDragGhost';
import { AppFolderOverlay } from '../components/os/launcher/AppFolderOverlay';
import {
    FOLDER_KIND, canDropAppOnItem, dropAppOnItem, removeAppFromFolder, renameFolder, reorderFolderApps,
} from '../utils/desktopFolders';
import {
    GRID_COLS, GRID_ROWS, rowsForScreen,
    resolveDesktopLayout, collectPlacedAppIds,
    emptyPage, addItem, addItemToPageOrInsert, removeItem, removePage, resizeItem, toggleLock, canPlace,
    tryDisplace, applyDisplacements, moveAppToDock, moveAppFromDock, reorderDock, dissolveFolderOntoPages,
} from '../utils/desktopGrid';
import { Plus, X, House, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useIsDesktopMode } from '../hooks/useDeviceMode';
import { trackEvent } from '../utils/analytics';

const CompanionHome = React.lazy(() => import('../components/os/CompanionHome'));

// ARCHITECTURE REVIEW REQUIRED：整理态仍编排条目拖拽、跨页放置及临时页生命周期。
// --- 自由网格桌面 ---
// 每页 = GRID_COLS × GRID_ROWS 格子矩阵；App 与小组件都是 PlacedItem，按 (x,y,w,h) 摆，
// 允许任意留空。数据模型 / 纯逻辑见 utils/desktopGrid.ts，组件渲染见 desktopWidgetRegistry。
// DesktopClock / CharacterWidget / DesktopSquareImage 已抽到 components/os/widgets/。

// 格子边长绝对下限：AppIcon 的图标本体是写死的 56px（w-[3.5rem]，不跟着 cellPx
// 缩放），加间距和文字标签，72px 是能完整放下不被裁切的最小值。低于这个数字，
// 图标会被自己所在的格子裁切边界切掉一块，比"这一行/这一页放不下、干净整行
// 隐藏"严重得多——所以这不是"越小越省空间"的调优旋钮，是渲染正确性的硬下限。
const MIN_CELL_PX = 72;

// 长按进整理态阈值：原来 520ms 偏短，正常单击稍慢一点就容易被判成长按，
// 点开 App 的点击被吞掉却毫无征兆。调到 620ms 拉开与单击的安全距离；
// WARN_MS 是提前量，从这个时刻起图标会轻微下沉变暗作为"再按住就要进编辑了"
// 的预警，用户看到就能主动松手取消，不会莫名其妙地打不开 App。
const LONGPRESS_MS = 620;
const LONGPRESS_WARN_MS = 340;
const PAGE_TURN_INITIAL_DELAY = 550;
const PAGE_TURN_REPEAT_DELAY = 900;
// 应用图标的标签约 12px，高度间距 6px；再留 4px 呼吸边距，避免第一行向上溢出后被页容器裁掉。
const APP_ICON_VERTICAL_RESERVE = 22;

const Launcher: React.FC = () => {
  const { openApp, characters, theme, updateTheme, isDataLoaded, unreadMessages } = useOS();
  const isDesktop = useIsDesktopMode();

  const {
    widgetChar, lastMessage, anniversaries, tasks, scheduleData, scheduleChar, setScheduleCharId,
  } = useLauncherWidgetData();
  const [scheduleViewerOpen, setScheduleViewerOpen] = useState(false);

  const [layoutEditing, setLayoutEditing] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryInitialTab, setGalleryInitialTab] = useState<'widgets' | 'apps'>('widgets');
  // 点 ◀+/+▶ 弹出的小菜单：选"普通页"还是"风车页"，为 null 时菜单关闭。
  const [addPageMenu, setAddPageMenu] = useState<null | 'left' | 'right'>(null);

  const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
  useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

  const handleSetStartPage = useCallback((pageId: string) => {
    const cur = theme.launcherStartPageId;
    void updateTheme({ launcherStartPageId: cur === pageId ? undefined : pageId });
  }, [theme.launcherStartPageId, updateTheme]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageGridRefs = useRef<(HTMLDivElement | null)[]>([]);

  // 格子边长只按宽度算，不管高度——所有页用同一个 cellPx，处处正方形。
  // 行数按页不同（rowsForScreen：首页矮、其它页高），但格子本身大小不变，
  // 格子边长只按宽度算，处处正方形。
  // 间距横 gap-x-2(8px) / 竖向 12px，网格紧凑精致，手机屏幕一屏完整放下。
  const [cellPx, setCellPx] = useState(78);
  useLayoutEffect(() => {
    const measure = () => {
      const raw = scrollContainerRef.current?.clientWidth || 380;
      // 电脑模式：允许桌面网格明显变宽变大，不再收窄成手机宽度——用户反馈过窄屏两侧
      // 大片空白不好看。仍然设上限，避免超宽屏下格子被拉得过于夸张；GRID_COLS 依旧
      // 是 4，不改列数（改列数要连带迁移所有已保存布局的坐标系，风险高得多），只是
      // 桌面模式适当加宽四列网格。
      const widthCap = isDesktop ? 46 * 16 : 24 * 16; // 手机 27rem(432px)，桌面 46rem(736px)
      const cellCap = isDesktop ? 108 : 96;
      const w = Math.min(raw, widthCap);
      const inner = w - PAGE_PAD_X * 2 - GRID_COL_GAP * (GRID_COLS - 1);
      // MIN_CELL_PX=72 不是随便定的：AppIcon 的图标本体是写死的 56px（w-[3.5rem]，
      // 不跟着 cellPx 缩放，见 components/os/AppIcon.tsx），加上间距和文字标签，
      // 72px 是能完整放下一枚图标+标签、不被格子裁切边界切掉的下限——之前手机端
      // 用了这么多年没出过事，就是因为手机最窄也有 375px 宽，从没让格子低于这个
      // 数字过。曾经尝试过把这个下限降到 48 来解决"窄窗口横向溢出"，结果 48px
      const widthBasedSize = Math.min(cellCap, Math.max(MIN_CELL_PX, Math.floor(inner / GRID_COLS)));

      // cellPx 一直只按宽度算，从没管过高度——手机上从没出过事，因为手机视口天生
      // 又窄又高，宽度算出来的格子边长顺手就在纵向也放得下。但桌面窗口可以被浏览器
      // 缩放（Ctrl+滚轮）压得又宽又矮，宽度那边还有富余、纵向却装不下 6 行格子，
      // 表现出来就是第二行图标和下面悬浮的分页胶囊、Dock 挤在一起截断/重叠。
      // 用标准页（7 行 + 最小的 pt-2/pb-4 留白）当最紧张的场景反推一个高度上限：
      // 分页胶囊是绝对定位悬浮在网格上方 `bottomInset + 5.5rem` 处，这块空间必须
      // 留出来，不能被格子占掉。
      const scrollH = scrollContainerRef.current?.clientHeight || 700;
      const windmillPadding = 8 + 16; // pt-2 + pb-4
      const indicatorReserve = 20 + 88; // launcherBottomInset(1.25rem) + 5.5rem
      const availableForGrid = scrollH - windmillPadding - indicatorReserve;
      const rowGapTotal = GRID_ROW_GAP * (GRID_ROWS - 1);
      // cellHeightFor(p) 恒等于 p - (GRID_ROW_GAP - GRID_COL_GAP) / 2，这里反解出
      // 「纵向最多能放下多大的 cellPx」，具体推导见 cellHeightFor 定义。
      const heightBasedSize = Math.floor((availableForGrid - rowGapTotal) / GRID_ROWS) + (GRID_ROW_GAP - GRID_COL_GAP) / 2;

            const size = isDesktop
        ? Math.max(MIN_CELL_PX, Math.min(widthBasedSize, heightBasedSize))
        : widthBasedSize;
      setCellPx(prev => (prev === size ? prev : size));
    };
    measure();
    // 用 ResizeObserver 盯着容器本身，而不是只听 window 的 resize：高度这边真正会
    // 变的时机不止"用户拖窗口/缩放"——开机锁屏卸载、字体加载完成撑高角色卡这些
    // 都会让 scrollContainerRef 的实际可用高度在不触发 window resize 的情况下悄悄
    // 变化。之前只挂 window resize 时试过，量出来的高度是开机早期一次性量到的偏
    // 大的值，之后从没重新量过，导致第二页往后这种高行数页面照旧被截断——这是
    // 实测复现过的真问题，不是纸面推理。
    const ro = new ResizeObserver(measure);
    if (scrollContainerRef.current) ro.observe(scrollContainerRef.current);
    return () => ro.disconnect();
  }, [isDesktop]);
  const gridWidthPx = GRID_COLS * cellPx + (GRID_COLS - 1) * GRID_COL_GAP;

  // ───────── 页面数据 ─────────
  const validAppIds = useMemo(
    () => new Set(
      getInstalledAppDefinitions(APP_REGISTRY)
        .filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible)
        .map(a => a.id),
    ),
    [devDebugVisible],
  );

  const resolvedLayout = useMemo(() => {
    return resolveDesktopLayout(
      theme.launcherLayout,
      validAppIds,
      getDefaultDockAppIds(APP_REGISTRY) as unknown as string[],
      (error) => console.error('[Launcher] desktopLayout 解析失败，退回默认桌面：', error),
    );
  }, [theme.launcherLayout, validAppIds]);

  const resolvedPages = resolvedLayout.pages;
  const resolvedDockIds = resolvedLayout.dock;

  const [pages, setPages] = useState<DesktopPage[]>(resolvedPages);
  const [dockAppIds, setDockAppIds] = useState<string[]>(resolvedDockIds);
  const pagesRef = useRef(pages);
  const dockRef = useRef(resolvedDockIds);
  useEffect(() => { pagesRef.current = pages; }, [pages]);

  // 不在编辑态时跟随 theme（备份导入 / 另一个标签页改了）
  useEffect(() => {
    if (layoutEditing) return;
    setPages(resolvedPages);
    pagesRef.current = resolvedPages;
    setDockAppIds(resolvedDockIds);
    dockRef.current = resolvedDockIds;
  }, [resolvedPages, resolvedDockIds, layoutEditing]);

  // 首次缺少 launcherLayout 时写入当前默认布局
  const initialLayoutPersisted = useRef(false);
  useEffect(() => {
    if (initialLayoutPersisted.current || !isDataLoaded) return;
    if (theme.launcherLayout) { initialLayoutPersisted.current = true; return; }
    initialLayoutPersisted.current = true;
    void updateTheme({ launcherLayout: resolvedLayout });
  }, [isDataLoaded, theme.launcherLayout, resolvedLayout, updateTheme]);

  const commitLayout = useCallback((next: DesktopLayout) => {
    pagesRef.current = next.pages;
    dockRef.current = next.dock;
    setPages(next.pages);
    setDockAppIds(next.dock);
    void updateTheme({ launcherLayout: next });
  }, [updateTheme]);

  const commitPages = useCallback((next: DesktopPage[]) => {
    commitLayout({ version: 1, pages: next, dock: dockRef.current });
  }, [commitLayout]);

  const replacePage = useCallback((pageIndex: number, nextPage: DesktopPage) => {
    const next = pagesRef.current.map((p, i) => (i === pageIndex ? nextPage : p));
    commitPages(next);
  }, [commitPages]);

  const placedAppIds = useMemo(() => collectPlacedAppIds(pages), [pages]);
  const existingKinds = useMemo(() => {
    const s = new Set<GridItemKind>();
    for (const p of pages) for (const it of p.items) s.add(it.kind);
    return s;
  }, [pages]);

  const totalPages = pages.length;

  const {
    activePageIndex, activePageIndexRef, initialScrollDone, handleScroll,
    setCurrentPage, scrollToPage, jumpToPage, beginPageSwipe, finishSwipe, snapToNearestPage, lockNativePan,
  } = useLauncherPaging({
    pagesRef,
    scrollContainerRef,
    startPageId: theme.launcherStartPageId,
    isDataLoaded,
    // 实际滚动时撤销等待中的长按，避免触屏滑动与拖拽同时起手。
    onScroll: () => {
      const current = gesture.current;
      const pendingNativeDrag = current?.mode === 'move' && current.usesNativePan && !current.active;
      if (bgPressStart.current || itemPressStart.current || pendingNativeDrag) clearPress();
      if (pendingNativeDrag) gesture.current = null;
    },
    onScrollPageChange: () => setAddPageMenu(null),
  });

  // 桌面鼠标拖拽翻页（非编辑态，窗口级平滑追踪 + 惯性吸附）
  const stopMouseSwipeRef = useRef<(() => void) | null>(null);
  // 鼠标拖动、整理态手指滑动、双指翻页共用一个，新手势会取消上一次还没执行的吸附恢复。
  const mouseMoved = useRef(0);
  const suppressClickUntil = useRef(0);

  // 只认「真鼠标」：绑在 onPointerDown 上并用 pointerType 过滤，而不是绑在
  // onMouseDown/window 'mousemove'/'mouseup' 上。原因：手机浏览器在一次触摸
  // 结束后经常会补发一遍兼容性的 mousedown/mouseup/click（无障碍/兼容历史包袱），
  // 之前这段逻辑绑的正是这几个事件——每次真实的手指滑动都会被这几个"迟到"的
  // 假鼠标事件二次触发一遍：先把 scroll-snap 关掉，再在 mouseup 里用一个（相对
  // 触摸手势而言）过时的起始坐标算出一个目标页，强行 scrollTo 回去——原生触摸
  // 滚动明明已经顺滑地停在正确的页上，却被这段代码"纠正"回去或叠加一次动画，
  // 表现出来就是横向来回抖一下。PointerEvent 自带 pointerType，触摸产生的指针
  // 永远是 'touch'，不会被误判成 'mouse'，从根上避免踩到这个兼容事件的坑。
  const handleMouseDown = (e: React.PointerEvent) => {
    if (!scrollContainerRef.current || e.pointerType !== 'mouse' || e.button !== 0) return;

    // 整理态下网格条目由自己的拖拽手势接管。
    if (
      layoutEditing &&
      (e.target as HTMLElement).closest('[data-grid-item], [data-grid-action]')
    ) return;
    const scroller = scrollContainerRef.current;
    const pointerId = e.pointerId;
    const startX = e.pageX;
    const startTime = Date.now();
    const startLeft = scroller.scrollLeft;
    let dx = 0;
    stopMouseSwipeRef.current?.();
    mouseMoved.current = 0;

    // 拖动过程中临时禁用 CSS snap，确保像素级跟随鼠标，不被吸附引擎强行拉扯
    beginPageSwipe();

    const onWindowPointerMove = (me: PointerEvent) => {
      if (me.pointerId !== pointerId || scrollContainerRef.current !== scroller) return;
      dx = me.pageX - startX;
      scroller.scrollLeft = startLeft - dx;
      mouseMoved.current = Math.abs(dx);
    };

    const stopMouseSwipe = () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      stopMouseSwipeRef.current = null;
    };

    const onWindowPointerUp = (ue: PointerEvent) => {
      if (ue.pointerId !== pointerId) return;
      stopMouseSwipe();
      if (scrollContainerRef.current !== scroller) return;

      if (mouseMoved.current > 5) {
        suppressClickUntil.current = Date.now() + 250;
      }

      const releaseDx = ue.type === 'pointercancel' ? dx : ue.pageX - startX;
      finishSwipe(startLeft, releaseDx, Date.now() - startTime);
    };

    stopMouseSwipeRef.current = stopMouseSwipe;
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
  };

  const handleClickCapture = (e: React.MouseEvent) => {
    if (layoutEditing) {
      const target = e.target as HTMLElement;
      // 徽标操作按钮（删除、锁定、缩放）放行
      if (target.closest('[data-grid-action]')) {
        return;
      }
      // 组件内快捷操作（如黑胶深浅色切换、贴纸等）放行
      if (target.closest('[data-action="widget-action"]')) {
        return;
      }
      // 风车四宫格（quad_apps）、天气组件（weather）、文件夹（点开改名 / 拖出）在编辑态下要响应点击，放行
      if (target.closest('[data-grid-kind="quad_apps"]') || target.closest('[data-grid-kind="weather"]') || target.closest(`[data-grid-kind="${FOLDER_KIND}"]`)) {
        return;
      }
      // 其他网格条目在编辑态下拦截点击，禁止打开 App
      const itemEl = target.closest('[data-grid-item]');
      if (itemEl) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
    if (mouseMoved.current > 5 || Date.now() < suppressClickUntil.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };


  // ───────── 编辑态：长按进入 + 拖拽 / 改大小 ─────────
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageTurnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageTurnDir = useRef<-1 | 0 | 1>(0);
  const lastPointerPos = useRef<{ clientX: number; clientY: number } | null>(null);
  // 拖到最后一页右边临时加出来的页：只在界面上，松手真放上去了才随布局一起保存。
  const tempPageIdRef = useRef<string | null>(null);
  const gesture = useRef<null | ({
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    grabDX?: number;
    grabDY?: number;
    el?: HTMLElement;
    ghost?: HTMLElement;
    active: boolean;
    scrollStartLeft?: number;
    usesNativePan?: boolean;
    releaseNativePan?: () => void;
  } & (
    | { mode: 'dock'; appId: AppID; item?: undefined; fromPage?: undefined }
    | { mode: 'move' | 'resize' | 'scroll'; item?: PlacedItem; fromPage?: number }
  ))>(null);
  const [dragPreview, setDragPreview] = useState<DesktopDragPreview | null>(null);
  const [dockDropActive, setDockDropActive] = useState(false);
  const [dragDockAppId, setDragDockAppId] = useState<AppID | null>(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!layoutEditing || !scroller) return;
    const preventPanWhileDragging = (event: TouchEvent) => {
      const current = gesture.current;
      // 普通横滑交给原生滚动。只有已经拿起条目时，才阻止浏览器抢走拖拽。
      if (event.cancelable && current?.active && (current.mode === 'move' || current.mode === 'dock')) {
        event.preventDefault();
      }
    };
    scroller.addEventListener('touchmove', preventPanWhileDragging, { capture: true, passive: false });
    return () => scroller.removeEventListener('touchmove', preventPanWhileDragging, true);
  }, [layoutEditing, theme.skin]);

  // 长按预警：按到临界值前一小段时间，先让被按住的图标轻微下沉变暗，
  // 给用户一个「再按住就要进编辑态了」的信号，可以主动松手取消——
  // 不然单击稍微慢一点点、又完全没有过渡提示，很容易莫名其妙把 App 点开失败。
  const pressWarnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressWarnEl = useRef<HTMLElement | null>(null);
  const clearPressWarn = () => {
    if (pressWarnTimer.current) clearTimeout(pressWarnTimer.current);
    pressWarnTimer.current = null;
    pressWarnEl.current?.classList.remove('launcher-press-warn');
    pressWarnEl.current = null;
  };
  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    clearPressWarn();
  };
  const clearPageTurn = () => { if (pageTurnTimer.current) clearTimeout(pageTurnTimer.current); pageTurnTimer.current = null; pageTurnDir.current = 0; };

  const displaceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredDisplaceTarget = useRef<{
    pageIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
    key: string;
  } | null>(null);

  const clearDisplaceTimer = useCallback(() => {
    if (displaceTimer.current) {
      clearTimeout(displaceTimer.current);
      displaceTimer.current = null;
    }
    hoveredDisplaceTarget.current = null;
  }, []);

  // 长按桌面空白处（不是某个图标/组件）也能进整理态，不用非得按在图标上。
  const bgPressStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const onBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-grid-item], [data-grid-action]')) return;
    if (layoutEditing) return;
    clearPress();
    bgPressStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    pressTimer.current = setTimeout(() => {
      if (!bgPressStart.current || bgPressStart.current.pointerId !== e.pointerId) return;
      bgPressStart.current = null;
      setLayoutEditing(true);
      trackEvent('进入桌面整理模式（空白处长按）');
    }, LONGPRESS_MS);
  };

  // 拖拽「幽灵」元素直接挂在 document.body 上（脱离 React 管控），只靠自己清理。
  // 手机上偶尔会出现清不掉的残影（真机上 pointerup/pointercancel 没有可靠触发，
  // 比如系统手势打断、切后台），所以除了正常清理，再加一道扫场兜底：
  // 进入/退出整理态、每次按下新的拖拽、组件挂载卸载时都清一遍，绝不留死角。
  const sweepStrayGhosts = () => {
    document.querySelectorAll('.launcher-drag-ghost').forEach(el => el.remove());
  };
  useEffect(() => {
    sweepStrayGhosts(); // 挂载时清掉上个会话/崩溃可能留下的残影
    return () => {
      clearPress(); clearPageTurn(); clearDisplaceTimer();
      stopMouseSwipeRef.current?.();
      gesture.current?.releaseNativePan?.();
      gesture.current?.ghost?.remove();
      sweepStrayGhosts();
    };
  }, []);

  const activateItemDrag = (g: NonNullable<typeof gesture.current>, source: HTMLElement, clientX: number, clientY: number) => {
    const capture = source.closest<HTMLElement>('[data-launcher-root]') ?? source;
    capture.setPointerCapture(g.pointerId);
    if (g.usesNativePan) g.releaseNativePan = lockNativePan();
    sweepStrayGhosts();
    const isDock = g.mode === 'dock';
    const { ghost, rect } = createDragGhost(source, {
      hitTestAttribute: isDock ? 'data-dock-app' : 'data-grid-item',
      className: 'launcher-drag-ghost',
      style: isDock
        ? { opacity: '0.92', transform: 'scale(1.08)', filter: 'drop-shadow(0 12px 16px rgba(15,23,42,.32))' }
        : { transform: 'scale(1.04)' },
    });
    g.active = true;
    g.ghost = ghost;
    g.grabDX = isDock ? rect.width / 2 : clientX - rect.left;
    g.grabDY = isDock ? rect.height / 2 : clientY - rect.top;
    if (isDock) setDragDockAppId(g.appId);
    else source.style.opacity = '0.18';
    suppressClickUntil.current = Date.now() + 400;
  };

  const cellFromPoint = (pageIndex: number, clientX: number, clientY: number, w: number, h: number) => {
    const el = pageGridRefs.current[pageIndex];
    if (!el) return null;
    const page = pagesRef.current[pageIndex];
    if (!page) return null;
    const rows = rowsForScreen(page);
    // 命中测试要跟渲染用的同一份公式，否则拖拽落点会跟视觉格子对不上。
    const rowGap = GRID_ROW_GAP;
    const cellH = cellHeightFor(cellPx);
    const r = el.getBoundingClientRect();
    let col = Math.floor((clientX - r.left) / (cellPx + GRID_COL_GAP));
    let row = Math.floor((clientY - r.top) / (cellH + rowGap));
    col = Math.max(0, Math.min(GRID_COLS - w, col));
    row = Math.max(0, Math.min(rows - h, row));
    return { x: col, y: row };
  };

  // 以被拖拽条目的首个 1×1 单元几何中心为基准探测网格落点：只要重叠度超过 50%，即可灵敏对称地命中目标格子
  const itemCellFromPoint = useCallback((
    pageIndex: number,
    clientX: number,
    clientY: number,
    item: { w: number; h: number },
    grabDX: number = 0,
    grabDY: number = 0,
  ) => {
    const cellH = cellHeightFor(cellPx);
    return cellFromPoint(
      pageIndex,
      clientX - grabDX + cellPx / 2,
      clientY - grabDY + cellH / 2,
      item.w,
      item.h,
    );
  }, [cellPx]);

  // 记录拖拽过程中是否临时自动新建了末尾页，用于在用户未放置时撤销清理
  // 多点触控：主手指拖拽 App 期间，允许第二根手指在屏幕上滑动翻页
  const secondaryScrollRef = useRef<{ pointerId: number; startX: number; scrollStartLeft: number } | null>(null);

  // 计算拖拽落点及邻近避让（挤开）方案：若目标格子被占用，且旁边有空位可容纳，则挤开原条目
  const resolveDragPlacement = useCallback((
    pageIndex: number,
    targetCell: { x: number; y: number },
    w: number,
    h: number,
    ignoreId?: string,
  ) => {
    const page = pagesRef.current[pageIndex];
    if (!page) return { ok: false, displacements: undefined };
    const rows = rowsForScreen(page);
    const disp = tryDisplace(page, { x: targetCell.x, y: targetCell.y, w, h }, ignoreId, GRID_COLS, rows);
    if (disp && disp.ok) {
      return { ok: true, displacements: disp.displacedItems.size > 0 ? disp.displacedItems : undefined };
    }
    return { ok: false, displacements: undefined };
  }, []);

  // 带防抖延迟的拖拽落点与避让设置：当需要挤开邻近条目时，需悬停停留一定时间（360ms）才触发位移，防止快速划过造成图标乱跳
  const setDragPlacementWithDwell = useCallback((
    pageIndex: number,
    cell: { x: number; y: number },
    w: number,
    h: number,
    ignoreId?: string,
  ) => {
    const { ok, displacements } = resolveDragPlacement(pageIndex, cell, w, h, ignoreId);
    if (!ok) {
      clearDisplaceTimer();
      setDragPreview({ pageIndex, x: cell.x, y: cell.y, w, h, ok: false, displacements: undefined });
      return;
    }

    if (!displacements || displacements.size === 0) {
      // 目标位置为空白区域，无需挤开任何已有条目：立即显示候选框，清除悬停倒计时
      clearDisplaceTimer();
      setDragPreview({ pageIndex, x: cell.x, y: cell.y, w, h, ok: true, displacements: undefined });
      return;
    }

    // 目标位置已被占用，需要挤开邻近条目：启用悬停防抖延迟（280ms），避免手指滑动经过时产生过度灵敏的图标晃动
    const targetKey = `${pageIndex}:${cell.x},${cell.y}:${w}x${h}`;
    if (hoveredDisplaceTarget.current?.key === targetKey) {
      // 仍然停留在同一个被占用的格子上：若计时器正在跑则继续等待，若已触发过则保持当前位移不变
      return;
    }

    // 进入了新的被占用格子：立即清除上一格的计时器，先显示该格子的静态候选，待悬停稳定后再挤开
    if (displaceTimer.current) {
      clearTimeout(displaceTimer.current);
      displaceTimer.current = null;
    }
    hoveredDisplaceTarget.current = { pageIndex, x: cell.x, y: cell.y, w, h, key: targetKey };
    setDragPreview({ pageIndex, x: cell.x, y: cell.y, w, h, ok: true, displacements: undefined });

    displaceTimer.current = setTimeout(() => {
      displaceTimer.current = null;
      if (
        gesture.current?.active &&
        gesture.current.mode === 'move' &&
        hoveredDisplaceTarget.current?.key === targetKey
      ) {
        try {
          if (typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(12);
          }
        } catch {}
        setDragPreview(prev => {
          if (!prev || prev.pageIndex !== pageIndex || prev.x !== cell.x || prev.y !== cell.y) return prev;
          return { ...prev, ok: true, displacements };
        });
      }
    }, 280);
  }, [resolveDragPlacement, clearDisplaceTimer]);

  // 手指在目标图标中间（宽高各 60% 的区域）才算要合成 / 放进文件夹
  const folderDropTargetAt = (pageIndex: number, hitElement: Element | null, clientX: number, clientY: number, dragged: PlacedItem): PlacedItem | null => {
    const page = pagesRef.current[pageIndex];
    if (!page || !dragged.refId) return null;
    const hit = hitElement?.closest<HTMLElement>('[data-grid-item]');
    const target = hit ? page.items.find(it => it.id === hit.dataset.gridItem) : undefined;
    if (!target || target.id === dragged.id || !canDropAppOnItem(target, dragged.refId)) return null;
    const rect = hit!.getBoundingClientRect();
    const insetX = rect.width * 0.2;
    const insetY = rect.height * 0.2;
    const inCenter = clientX > rect.left + insetX && clientX < rect.right - insetX
      && clientY > rect.top + insetY && clientY < rect.bottom - insetY;
    return inCenter ? target : null;
  };

  const queuePageTurn = (dir: -1 | 1) => {
    if (pageTurnDir.current === dir && pageTurnTimer.current) return;

    // 不在这里打断还在进行的翻页动画：以前重新排队就把滚动停在原地，手指在边缘区
    // 边界抖一下页面就卡在两页中间、被吸附拽回原页，而页码已经记成了下一页，松手
    // 会把条目放进看不见的那页。下一次翻页的 scrollToPage 会自然接管动画。
    clearPageTurn();
    pageTurnDir.current = dir;

    const turn = () => {
      const g = gesture.current;
      const scroller = scrollContainerRef.current;

      if (
        !g?.active ||
        g.mode !== 'move' ||
        !scroller ||
        pageTurnDir.current !== dir
      ) {
        clearPageTurn();
        return;
      }

      const cur = activePageIndexRef.current;
      let next = Math.max(
        0,
        Math.min(pagesRef.current.length - 1, cur + dir),
      );

      if (next === cur) {
        // 那一头已经没有页了：在那一头临时加一页（左右同一套，贴边规则也与翻页同一条）
        if (!g.item || !canAddPageAtEnd(pagesRef.current, cur, dir)) {
          clearPageTurn();
          return;
        }
        const tempPage = emptyPage(undefined, 'standard');
        tempPageIdRef.current = tempPage.id;
        const added = addPageAtEnd(pagesRef.current, tempPage, dir);
        pagesRef.current = added.pages;
        // 新页要先渲染出来，下面的滚动和落点计算才找得到它的格子
        flushSync(() => setPages(added.pages));
        // 插在前面时原有页整体后移一位：来源页号跟着改，滚动位置也立刻跟上，画面不跳
        g.fromPage = indexAfterInsert(g.fromPage!, added.index);
        scroller.scrollLeft = indexAfterInsert(cur, added.index) * scroller.clientWidth;
        next = added.index;
      }

      clearDisplaceTimer();

      try {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(15);
        }
      } catch {}

      scrollToPage(next);

      if (lastPointerPos.current && g.item) {
        const item = g.item;
        const cell = itemCellFromPoint(
          next,
          lastPointerPos.current.clientX,
          lastPointerPos.current.clientY,
          item,
          g.grabDX,
          g.grabDY,
        );

        if (cell) {
          const ignoreId = next === g.fromPage ? item.id : undefined;
          setDragPlacementWithDwell(
            next,
            cell,
            item.w,
            item.h,
            ignoreId,
          );
        }
      }

      // 手指一直贴着边就隔一段时间再翻一页
      pageTurnTimer.current = setTimeout(
        turn,
        PAGE_TURN_REPEAT_DELAY,
      );
    };

    pageTurnTimer.current = setTimeout(turn, PAGE_TURN_INITIAL_DELAY);
  };

  const itemPressStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  const onDockPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>, appId: AppID) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (gesture.current) return;
    const source = e.currentTarget.closest<HTMLElement>('[data-dock-app]');
    if (!source) return;
    clearPress();
    lastPointerPos.current = { clientX: e.clientX, clientY: e.clientY };
    const g = {
      mode: 'dock' as const, appId, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, startTime: Date.now(), active: false,
    };
    gesture.current = g;
    activateItemDrag(g, source, e.clientX, e.clientY);
  }, []);

  const onItemPointerDown = useCallback((e: React.PointerEvent, item: PlacedItem, pageIndex: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-grid-action]')) return; // 徽标按钮自己处理
    const itemEl = (e.target as HTMLElement).closest<HTMLElement>('[data-grid-item]');
    clearPress();

    if (!layoutEditing) {
      // 长按进入整理：记录起始坐标，若发生轻微移动则取消计时
      itemPressStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      if (itemEl) {
        pressWarnEl.current = itemEl;
        pressWarnTimer.current = setTimeout(() => {
          if (!itemPressStart.current || itemPressStart.current.pointerId !== e.pointerId) return;
          itemEl.classList.add('launcher-press-warn');
        }, LONGPRESS_WARN_MS);
      }
      pressTimer.current = setTimeout(() => {
        clearPressWarn();
        if (!itemPressStart.current || itemPressStart.current.pointerId !== e.pointerId) return;
        itemPressStart.current = null;
        setLayoutEditing(true);
        trackEvent('进入桌面整理模式');
        suppressClickUntil.current = Date.now() + 700;
      }, LONGPRESS_MS);
      return;
    }

    const usesNativePan = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (item.locked || !itemEl) {
      if (usesNativePan) return;
      // 鼠标在整理态跳过网格上的通用拖页入口，因此仍由此处识别横滑。
      gesture.current = {
        mode: 'scroll', pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY, startTime: Date.now(), active: false,
        scrollStartLeft: scrollContainerRef.current?.scrollLeft ?? 0,
      };
      return;
    }

    lastPointerPos.current = { clientX: e.clientX, clientY: e.clientY };
    gesture.current = {
      mode: 'move', pointerId: e.pointerId, item, fromPage: pageIndex,
      startX: e.clientX, startY: e.clientY, startTime: Date.now(), el: itemEl, active: false,
      scrollStartLeft: scrollContainerRef.current?.scrollLeft ?? 0,
      usesNativePan,
    };
    pressTimer.current = setTimeout(() => {
      const g = gesture.current;
      if (!g || g.pointerId !== e.pointerId || g.mode !== 'move' || !g.el) return;
      activateItemDrag(g, g.el, e.clientX, e.clientY);
    }, 160);
  }, [layoutEditing]);

  const onResizePointerDown = useCallback((e: React.PointerEvent, item: PlacedItem, pageIndex: number) => {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    gesture.current = {
      mode: 'resize', pointerId: e.pointerId, item, fromPage: pageIndex,
      startX: e.clientX, startY: e.clientY, startTime: Date.now(), active: true,
    };
    (e.target as HTMLElement).closest('[data-launcher-root]')?.setPointerCapture?.(e.pointerId);
    setDragPreview({ pageIndex, x: item.x, y: item.y, w: item.w, h: item.h, ok: true });
  }, []);

  // 多指手势：主手按住拖动 App 图标时，捕获第二根手指的滑动，实现边拖边滑屏翻页
  const onRootPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g?.active && (g.mode === 'move' || g.mode === 'dock') && e.pointerId !== g.pointerId) {
      e.stopPropagation();
      e.preventDefault();
      if (g.mode === 'dock') return;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      secondaryScrollRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        scrollStartLeft: scrollContainerRef.current?.scrollLeft ?? 0,
      };
      beginPageSwipe();
      return;
    }
  };

  const onRootPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 检查是否是副手指在滑屏翻页
    if (secondaryScrollRef.current && secondaryScrollRef.current.pointerId === e.pointerId) {
      const container = scrollContainerRef.current;
      if (container) {
        const dx = e.clientX - secondaryScrollRef.current.startX;
        container.scrollLeft = secondaryScrollRef.current.scrollStartLeft - dx;
      }
      return;
    }

    lastPointerPos.current = { clientX: e.clientX, clientY: e.clientY };

    if (bgPressStart.current && bgPressStart.current.pointerId === e.pointerId) {
      const dx = e.clientX - bgPressStart.current.x;
      const dy = e.clientY - bgPressStart.current.y;
      if (Math.hypot(dx, dy) > 10) { clearPress(); bgPressStart.current = null; }
      return; // 空白处手势不参与拖拽/改大小逻辑
    }
    if (itemPressStart.current && itemPressStart.current.pointerId === e.pointerId) {
      const dx = e.clientX - itemPressStart.current.x;
      const dy = e.clientY - itemPressStart.current.y;
      if (Math.hypot(dx, dy) > 8) { clearPress(); itemPressStart.current = null; }
    }
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;

    if (g.mode === 'resize' && g.item) {
      const limits = getWidgetSizeLimits(g.item.kind as WidgetKind) ?? { min: { w: 1, h: 1 }, max: { w: 1, h: 1 } };
      const rows = rowsForScreen(pagesRef.current[g.fromPage!]);
      const cell = cellFromPoint(g.fromPage!, e.clientX, e.clientY, 1, 1);
      if (!cell) return;
      let w = Math.max(limits.min.w, Math.min(limits.max.w, cell.x - g.item.x + 1, GRID_COLS - g.item.x));
      let h = Math.max(limits.min.h, Math.min(limits.max.h, cell.y - g.item.y + 1, rows - g.item.y));
      const ok = canPlace(pagesRef.current[g.fromPage!], { x: g.item.x, y: g.item.y, w, h }, g.item.id, GRID_COLS, rows);
      setDragPreview({ pageIndex: g.fromPage!, x: g.item.x, y: g.item.y, w, h, ok });
      return;
    }

    // 'scroll' 模式一旦确认就要一直跟手翻页，不能再卡在下面 `!g.active` 那道
    if (g.mode === 'scroll') {
      const container = scrollContainerRef.current;
      // 锁定图标上起手时先等到明确的横向位移，轻点不会意外拖动页面。
      if (!g.active) {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) <= 8 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        g.active = true;
        beginPageSwipe();
      }
      if (container && g.scrollStartLeft !== undefined) {
        container.scrollLeft = g.scrollStartLeft - (e.clientX - g.startX);
      }
      return;
    }

    if (!g.active) {
      // 触屏交给原生横滑。pointercancel 或实际滚动再撤销，轻微斜移仍可拿起条目。
      if (g.usesNativePan) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      // 鼠标在拿起条目前横向移动，仍可拖动页面。
      if (Math.hypot(dx, dy) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        clearPress();
        // 从这一下起就是翻页滑动，必须同时标成已开始：松手只给已开始的滑动恢复吸附，
        // 以前只改了 mode，快速甩一下（只有这一次 move 就松手）吸附会一直关着，
        // 页面能从头滑到尾、再也停不到整页上，退出整理态也恢复不了。
        g.mode = 'scroll';
        g.active = true;
        const container = scrollContainerRef.current;
        if (container) {
          beginPageSwipe();
          container.scrollLeft = (g.scrollStartLeft ?? container.scrollLeft) - dx;
        }
      }
      return;
    }

    // move
    e.preventDefault();
    if (g.ghost) {
      g.ghost.style.left = `${e.clientX - (g.grabDX || 0)}px`;
      g.ghost.style.top = `${e.clientY - (g.grabDY || 0)}px`;
    }
    const hit = e.currentTarget.ownerDocument.elementFromPoint(e.clientX, e.clientY);
    if (g.mode === 'dock') {
      setDragPreview(resolveDockGridDrop(hit, e.clientX, e.clientY));
      return;
    }

    const overDock = !!hit?.closest('[data-dock-drop-zone]');
    if (g.item?.kind === 'app' && g.item.refId && overDock) {
      clearPageTurn();
      clearDisplaceTimer();
      setDockDropActive(true);
      setDragPreview(null);
      return;
    }
    setDockDropActive(false);
    const rootRect = e.currentTarget.getBoundingClientRect();
    const edgeDir = edgeTurnDirection(e.clientX, rootRect, g.ghost?.getBoundingClientRect() ?? null, pageTurnDir.current);
    if (edgeDir !== 0) queuePageTurn(edgeDir);
    else clearPageTurn();

    const visPage = activePageIndexRef.current;
    const item = g.item!;
    const cell = itemCellFromPoint(visPage, e.clientX, e.clientY, item, g.grabDX, g.grabDY);
    if (!cell) {
      clearDisplaceTimer();
      setDragPreview(null);
      return;
    }

    // 拖着 App 停在另一个 App / 文件夹的中间：松手就合成文件夹或放进去。
    // 只认手指落在目标图标中间那一块，靠边时仍按普通挪位置处理。
    if (item.kind === 'app' && item.refId) {
      const folderTarget = folderDropTargetAt(visPage, hit, e.clientX, e.clientY, item);
      if (folderTarget) {
        clearDisplaceTimer();
        setDragPreview({
          pageIndex: visPage, x: folderTarget.x, y: folderTarget.y, w: 1, h: 1, ok: true,
          dropToFolder: { targetId: folderTarget.id, mode: folderTarget.kind === 'app' ? 'create' : 'add' },
        });
        return;
      }
    }

    // 拖拽 1×1 App 时，检测是否悬停在某个「四宫格风车组件」上方：直接吸附进四宫格
    if (item.kind === 'app' && item.refId) {
      const pCell = cellFromPoint(visPage, e.clientX, e.clientY, 1, 1);
      const hitCell = pCell || cell;
      if (hitCell) {
        const quad = pagesRef.current[visPage]?.items.find(it =>
          it.kind === 'quad_apps' &&
          hitCell.x >= it.x && hitCell.x < it.x + it.w &&
          hitCell.y >= it.y && hitCell.y < it.y + it.h
        );
        if (quad) {
          const quadApps: (string | null)[] = Array.isArray(quad.config?.apps)
            ? [0, 1, 2, 3].map(i => quad.config?.apps[i] ?? null)
            : [null, null, null, null];

          const alreadyInQuad = quadApps.includes(item.refId);
          if (!alreadyInQuad) {
            const slotX = hitCell.x - quad.x;
            const slotY = hitCell.y - quad.y;
            const hoveredSlot = Math.max(0, Math.min(3, slotY * 2 + slotX));

            let targetSlot = hoveredSlot;
            if (quadApps[hoveredSlot]) {
              const emptyIdx = [0, 1, 2, 3].find(idx => !quadApps[idx]);
              targetSlot = emptyIdx !== undefined ? emptyIdx : -1;
            }

            if (targetSlot >= 0) {
              clearDisplaceTimer();
              setDragPreview({
                pageIndex: visPage,
                x: quad.x,
                y: quad.y,
                w: quad.w,
                h: quad.h,
                ok: true,
                dropToQuad: {
                  quadId: quad.id,
                  pageIndex: visPage,
                  slotIndex: targetSlot,
                },
              });
              return;
            }
          }
        }
      }
    }

    const ignoreId = visPage === g.fromPage ? item.id : undefined;
    setDragPlacementWithDwell(visPage, cell, item.w, item.h, ignoreId);
  };

  // 删掉 removedAt 那一页后让当前页号和画面对上（临时页收回、拖空的页自动删都走这里）。
  // pages 是删完的页；persist 决定要不要写进布局（临时页从没保存过，只改界面）。
  const removePageKeepingView = (removedAt: number, pages: DesktopPage[], persist: boolean) => {
    if (persist) {
      flushSync(() => commitPages(pages));
    } else {
      pagesRef.current = pages;
      flushSync(() => setPages(pages));
    }
    const target = indexAfterRemove(activePageIndexRef.current, removedAt, pages.length);
    scrollToPage(target, 'auto');
  };

  // 临时加的页没放上东西就收回；返回它原来的下标（没有临时页时 -1），调用方据此改正手里的页号。
  const discardTempPage = (): number => {
    const tempId = tempPageIdRef.current;
    tempPageIdRef.current = null;
    if (!tempId) return -1;
    const index = pagesRef.current.findIndex(pg => pg.id === tempId);
    if (index < 0) throw new Error(`[Launcher] 临时页 ${tempId} 不在页面列表里`);
    removePageKeepingView(index, pagesRef.current.filter(pg => pg.id !== tempId), false);
    return index;
  };

  // 拖走一页上最后一个条目后自动删掉这张空页（主屏不删）。
  const dropPageEmptiedByDrag = (pageId: string) => {
    const index = pagesRef.current.findIndex(pg => pg.id === pageId);
    if (index < 0 || pagesRef.current[index].items.length > 0) return;
    const next = removePage(pagesRef.current, index);
    if (next === pagesRef.current) return;
    removePageKeepingView(index, next, true);
  };

  const onRootPointerUp = (e?: React.PointerEvent<HTMLDivElement>) => {
    // 1. 如果是副手指抬起
    if (secondaryScrollRef.current && e && secondaryScrollRef.current.pointerId === e.pointerId) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      secondaryScrollRef.current = null;
      const target = snapToNearestPage();
      if (target !== null) {
        clearDisplaceTimer();
        // 副手指翻页完成后，立即为目标页计算落点预览
        if (lastPointerPos.current && gesture.current?.item) {
          const item = gesture.current.item;
          const cell = itemCellFromPoint(target, lastPointerPos.current.clientX, lastPointerPos.current.clientY, item, gesture.current.grabDX, gesture.current.grabDY);
          if (cell) {
            const ignoreId = target === gesture.current.fromPage ? item.id : undefined;
            setDragPlacementWithDwell(target, cell, item.w, item.h, ignoreId);
          }
        }
      }
      return;
    }

    const g = gesture.current;

    // 如果是指针不匹配的其它未知指针抬起，忽略它，不破坏主手势
    if (e && g && g.pointerId !== e.pointerId) {
      return;
    }

    bgPressStart.current = null;
    itemPressStart.current = null;
    clearPress();
    clearPageTurn();
    clearDisplaceTimer();
    const isDrop = e?.type === 'pointerup';
    g?.releaseNativePan?.();
    g?.ghost?.remove();
    if (g?.el && g.ghost) g.el.style.opacity = '';

    if (g?.active && g.mode === 'dock' && isDrop) {
      const hit = e.currentTarget.ownerDocument.elementFromPoint(e.clientX, e.clientY);
      finishDockDrop(g.appId, hit, e.clientX, e.clientY);
    } else if (g?.active && g.mode === 'resize' && g.item && isDrop) {
      const p = dragPreview;
      if (p && p.ok) replacePage(g.fromPage!, resizeItem(pagesRef.current[g.fromPage!], g.item.id, p.w, p.h, GRID_COLS, rowsForScreen(pagesRef.current[g.fromPage!])));
    } else if (g?.active && g.mode === 'move' && g.item && isDrop) {
      const sourcePageId = pagesRef.current[g.fromPage!].id;
      const hit = e.currentTarget.ownerDocument.elementFromPoint(e.clientX, e.clientY);
      const droppedOnDock = g.item.kind === 'app' && !!g.item.refId && !!hit?.closest('[data-dock-drop-zone]');

      // 落点预览：若当前 dragPreview 为空或停在旧页，重新按当前停留在屏幕上的 activePageIndex 进行最终落点判定
      const visPage = activePageIndexRef.current;
      let finalPreview = dragPreview;
      if ((!finalPreview || finalPreview.pageIndex !== visPage) && lastPointerPos.current && g.item) {
        const item = g.item;
        const cell = itemCellFromPoint(visPage, lastPointerPos.current.clientX, lastPointerPos.current.clientY, item, g.grabDX, g.grabDY);
        if (cell) {
          const ignoreId = visPage === g.fromPage ? item.id : undefined;
          const { ok, displacements } = resolveDragPlacement(visPage, cell, item.w, item.h, ignoreId);
          finalPreview = { pageIndex: visPage, x: cell.x, y: cell.y, w: item.w, h: item.h, ok, displacements };
        }
      }

      // 若处于有效落点但因为手指停留时间未达到 360ms 悬停延迟导致 displacements 尚未填充，
      // 在松手落下的瞬间补齐 displacements，保证即刻松手（quick drop）也能正确挤开条目
      if (finalPreview && finalPreview.ok && !finalPreview.displacements && !finalPreview.dropToQuad && !finalPreview.dropToFolder) {
        const ignoreId = finalPreview.pageIndex === g.fromPage ? g.item.id : undefined;
        const { displacements } = resolveDragPlacement(
          finalPreview.pageIndex,
          { x: finalPreview.x, y: finalPreview.y },
          finalPreview.w,
          finalPreview.h,
          ignoreId
        );
        if (displacements) {
          finalPreview = { ...finalPreview, displacements };
        }
      }

      // 放到临时页上就留着它（随下面的跨页放置一起保存），否则先收回，再把手里的页号改正
      let p = finalPreview;
      const droppedOnTempPage = !droppedOnDock && !!p?.ok && pagesRef.current[p.pageIndex]?.id === tempPageIdRef.current;
      if (droppedOnTempPage) {
        tempPageIdRef.current = null;
      } else {
        const removedAt = discardTempPage();
        if (removedAt >= 0) {
          const count = pagesRef.current.length;
          g.fromPage = indexAfterRemove(g.fromPage!, removedAt, count);
          if (p) {
            p = {
              ...p,
              pageIndex: indexAfterRemove(p.pageIndex, removedAt, count),
              dropToQuad: p.dropToQuad && { ...p.dropToQuad, pageIndex: indexAfterRemove(p.dropToQuad.pageIndex, removedAt, count) },
            };
          }
        }
      }

      if (droppedOnDock && g.item.refId && handleMoveAppToDock(g.item.refId)) {
        trackEvent('桌面拖拽应用入 Dock');
      }

      if (!droppedOnDock && p && p.ok) {
        if (p.dropToFolder && g.item.kind === 'app' && g.item.refId) {
          const appRefId = g.item.refId;
          const { targetId } = p.dropToFolder;
          const nextPages = pagesRef.current
            .map((pg, pi) => (pi === g.fromPage ? removeItem(pg, g.item!.id) : pg))
            .map((pg, pi) => (pi === p.pageIndex ? dropAppOnItem(pg, targetId, appRefId) : pg));
          commitPages(nextPages);
          trackEvent(p.dropToFolder.mode === 'create' ? '桌面合成文件夹' : '桌面放入文件夹');
        } else if (p.dropToQuad && g.item.kind === 'app' && g.item.refId) {
          const { quadId, pageIndex: targetPi, slotIndex } = p.dropToQuad;
          const appRefId = g.item.refId;

          const srcPageWithoutApp = removeItem(pagesRef.current[g.fromPage!], g.item.id);
          const nextPages = pagesRef.current.map((pg, pi) => {
            let pageToUpdate = pi === g.fromPage ? srcPageWithoutApp : pg;
            if (pi === targetPi) {
              pageToUpdate = {
                ...pageToUpdate,
                items: pageToUpdate.items.map(it => {
                  if (it.id !== quadId) return it;
                  const curApps: (string | null)[] = Array.isArray(it.config?.apps)
                    ? [0, 1, 2, 3].map(i => it.config?.apps[i] ?? null)
                    : [null, null, null, null];
                  curApps[slotIndex] = appRefId;
                  return {
                    ...it,
                    config: { ...(it.config || {}), apps: curApps }
                  };
                })
              };
            }
            return pageToUpdate;
          });

          commitPages(nextPages);
          trackEvent('桌面拖拽收纳应用入四宫格');
        } else if (p.pageIndex === g.fromPage) {
          // 同一页内放置：应用挤开位移 + 移动自身到目标位置
          const pageWithDisplacement = applyDisplacements(pagesRef.current[g.fromPage!], p.displacements);
          const nextPg: DesktopPage = {
            ...pageWithDisplacement,
            items: pageWithDisplacement.items.map(i => i.id === g.item!.id ? { ...i, x: p.x, y: p.y } : i),
          };
          replacePage(g.fromPage!, nextPg);
        } else {
          // 跨页放置：原页移除被拖拽项，目标页应用挤开位移 + 添加被拖拽项
          const src = removeItem(pagesRef.current[g.fromPage!], g.item.id);
          const targetWithDisplacement = applyDisplacements(pagesRef.current[p.pageIndex], p.displacements);
          const placed = addItem(targetWithDisplacement, {
            kind: g.item.kind, refId: g.item.refId, w: g.item.w, h: g.item.h,
            locked: g.item.locked, title: g.item.title, config: g.item.config,
            x: p.x, y: p.y,
          }, GRID_COLS, rowsForScreen(pagesRef.current[p.pageIndex]));
          const next = pagesRef.current.map((pg, i) =>
            i === g.fromPage ? src : i === p.pageIndex ? (placed?.page ?? targetWithDisplacement) : pg);
          commitPages(next);

        }
      }

      dropPageEmptiedByDrag(sourcePageId);
      suppressClickUntil.current = Date.now() + 400;
    } else if (g?.active && g.mode === 'scroll') {
      if (g.scrollStartLeft !== undefined) {
        // pointercancel 的坐标可能是 0，用最后一次移动的位置。
        const endX = isDrop ? e.clientX : (lastPointerPos.current?.clientX ?? g.startX);
        const target = finishSwipe(g.scrollStartLeft, endX - g.startX, Date.now() - g.startTime);
        if (target !== null) setCurrentPage(target);
      }
    }
    discardTempPage();
    setDragPreview(null);
    setDockDropActive(false);
    setDragDockAppId(null);
    gesture.current = null;
  };

  const finishEditing = () => { onRootPointerUp(); sweepStrayGhosts(); setLayoutEditing(false); setAddPageMenu(null); };

  // ───────── 条目增删 / 页面增删 ─────────
  const handleDeleteItem = useCallback((pageIndex: number, itemId: string) => {
    const target = pagesRef.current[pageIndex]?.items.find(it => it.id === itemId);
    if (target?.kind === FOLDER_KIND) {
      // 删文件夹不删里面的 App：放回桌面空位
      commitPages(dissolveFolderOntoPages(pagesRef.current, pageIndex, itemId));
      trackEvent('桌面解散文件夹');
      return;
    }
    replacePage(pageIndex, removeItem(pagesRef.current[pageIndex], itemId));
    trackEvent('桌面移除条目');
  }, [replacePage, commitPages]);

  const handleToggleLock = useCallback((pageIndex: number, itemId: string) => {
    replacePage(pageIndex, toggleLock(pagesRef.current[pageIndex], itemId));
  }, [replacePage]);

  const handleUpdateItemConfig = useCallback((item: PlacedItem, patch: Record<string, unknown>) => {
    const pageIndex = pagesRef.current.findIndex(page => page.items.some(current => current.id === item.id));
    if (pageIndex < 0) return;
    const page = pagesRef.current[pageIndex];
    replacePage(pageIndex, {
      ...page,
      items: page.items.map(current => current.id === item.id
        ? { ...current, config: { ...(current.config || {}), ...patch } }
        : current),
    });
  }, [replacePage]);

  const registerPageGridRef = useCallback((index: number, el: HTMLDivElement | null) => {
    pageGridRefs.current[index] = el;
  }, []);

  const handleOpenChat = useCallback(() => {
    if (layoutEditing) return;
    openApp(AppID.Chat);
  }, [layoutEditing, openApp]);

  const handleAddToCurrentPage = useCallback((spec: { kind: GridItemKind; refId?: string }) => {
    const current = pagesRef.current;
    const next = addItemToPageOrInsert(current, activePageIndexRef.current, spec);
    if (next === current) return;
    commitPages(next);
    trackEvent('桌面添加条目', { kind: spec.kind });
  }, [activePageIndexRef, commitPages]);

  const handleMoveAppToDock = useCallback((appId: string) => {
    const next = moveAppToDock({ version: 1, pages: pagesRef.current, dock: dockRef.current }, appId);
    if (next.dock === dockRef.current) return false;
    commitLayout(next);
    return true;
  }, [commitLayout]);

  const handleRemoveFromDock = useCallback((appId: string) => {
    if (!dockRef.current.includes(appId)) return;
    commitLayout({ version: 1, pages: pagesRef.current, dock: dockRef.current.filter(id => id !== appId) });
    trackEvent('Dock 移除应用');
  }, [commitLayout]);

  const resolveDockGridDrop = (hit: Element | null, clientX: number, clientY: number): DesktopDragPreview | null => {
    const grid = hit?.closest<HTMLDivElement>('[data-desktop-grid]');
    const pageIndex = grid ? pageGridRefs.current.indexOf(grid) : -1;
    const page = pagesRef.current[pageIndex];
    const cell = page ? cellFromPoint(pageIndex, clientX, clientY, 1, 1) : null;
    if (!page || !cell) return null;
    return {
      pageIndex,
      ...cell,
      w: 1,
      h: 1,
      ok: canPlace(page, { x: cell.x, y: cell.y, w: 1, h: 1 }, undefined, GRID_COLS, rowsForScreen(page)),
    };
  };

  const finishDockDrop = (appId: AppID, hit: Element | null, clientX: number, clientY: number) => {
    const currentLayout: DesktopLayout = { version: 1, pages: pagesRef.current, dock: dockRef.current };
    const grid = resolveDockGridDrop(hit, clientX, clientY);
    if (grid) {
      const { pageIndex, x, y, ok } = grid;
      if (!ok) return;
      const next = moveAppFromDock(currentLayout, appId, pageIndex, { x, y });
      if (next === currentLayout) return;
      commitLayout(next);
      trackEvent('Dock 拖拽应用回桌面');
      return;
    }

    const target = hit?.closest<HTMLElement>('[data-dock-app]');
    const targetId = target?.dataset.dockApp;
    if (!target || !targetId || targetId === appId) return;
    const sourceIndex = currentLayout.dock.indexOf(appId);
    const hitIndex = currentLayout.dock.indexOf(targetId);
    if (sourceIndex < 0 || hitIndex < 0) return;
    const rect = target.getBoundingClientRect();
    const targetIndex = hitIndex + (clientX > rect.left + rect.width / 2 ? 1 : 0);
    const order = [...currentLayout.dock];
    order.splice(sourceIndex, 1);
    order.splice(targetIndex - (sourceIndex < targetIndex ? 1 : 0), 0, appId);
    const next = reorderDock(currentLayout, order);
    if (next !== currentLayout) commitLayout(next);
  };

  // 新页插在"当前页的左边"还是"右边"——不再是只能往最后追加一页。主屏的表头
  // 跟着 layout:'home' 标记走（见 desktopGrid.ts），不跟下标，所以就算往主屏左边
  // 插页把主屏从下标 1 挤到别的位置，表头也不会跟丢。
  const handleAddPage = useCallback((direction: 'left' | 'right', layout: 'windmill' | 'standard' = 'standard') => {
    const cur = activePageIndexRef.current;
    const insertAt = direction === 'left' ? cur : cur + 1;
    const newPage = emptyPage(undefined, layout);
    const next = [
      ...pagesRef.current.slice(0, insertAt),
      newPage,
      ...pagesRef.current.slice(insertAt),
    ];
    commitPages(next);
    setCurrentPage(insertAt);
    const el = scrollContainerRef.current;
    if (el) {
      // 插在左边时前面页数变多，得等这一帧布局（页宽 × 下标）落定了再跳，
      // 不然会用旧的页面数量算出错误的 scrollLeft。
      requestAnimationFrame(() => {
        scrollToPage(insertAt, 'auto');
      });
    }
  }, [commitPages, scrollToPage, setCurrentPage]);

  const handleRemovePage = useCallback((pageIndex: number) => {
    const next = removePage(pagesRef.current, pageIndex);
    if (next === pagesRef.current) return;
    commitPages(next);
    const clamped = Math.min(activePageIndexRef.current, next.length - 1);
    setCurrentPage(clamped);
  }, [commitPages, setCurrentPage]);

  // 相框换图：写回某个 image 条目的 config.src
  const [imagePicker, setImagePicker] = useState<{ pageIndex: number; itemId: string; src?: string } | null>(null);
  const setItemConfigSrc = useCallback((pageIndex: number, itemId: string, src: string | undefined) => {
    const p = pagesRef.current[pageIndex];
    if (!p) return;
    replacePage(pageIndex, {
      ...p,
      items: p.items.map(it => it.id === itemId ? { ...it, config: { ...(it.config || {}), src } } : it),
    });
  }, [replacePage]);
  const openImagePicker = useCallback((item: PlacedItem) => {
    const pi = pagesRef.current.findIndex(p => p.items.some(i => i.id === item.id));
    if (pi < 0) return;
    setImagePicker({ pageIndex: pi, itemId: item.id, src: item.config?.src });
  }, []);

  // 四宫格组件管理：点击打开管理抽屉，直观查看 4 个槽位并增删替换
  const [quadManagerTarget, setQuadManagerTarget] = useState<{
    pageIndex: number;
    itemId: string;
    slotIndex?: number;
  } | null>(null);

  const handleOpenQuadManager = useCallback((item: PlacedItem, slotIndex?: number) => {
    const pi = pagesRef.current.findIndex(p => p.items.some(i => i.id === item.id));
    if (pi < 0) return;
    setQuadManagerTarget({ pageIndex: pi, itemId: item.id, slotIndex });
  }, []);

  // 文件夹弹层：按 id 记，页码每次现查，文件夹被挪页或解散后自动对上 / 关掉
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const handleOpenFolder = useCallback((item: PlacedItem) => setOpenFolderId(item.id), []);
  const findFolderPage = (folderId: string) => pagesRef.current.findIndex(p => p.items.some(i => i.id === folderId));

  const handleRenameFolder = useCallback((folderId: string, name: string) => {
    const pi = findFolderPage(folderId);
    replacePage(pi, renameFolder(pagesRef.current[pi], folderId, name));
  }, [replacePage]);

  const handleReorderFolder = useCallback((folderId: string, apps: string[]) => {
    const pi = findFolderPage(folderId);
    replacePage(pi, reorderFolderApps(pagesRef.current[pi], folderId, apps));
  }, [replacePage]);

  // 从文件夹拖出：放到当前这页手指松开的格子，占了就找本页空位，本页满了在后面加一页
  const handleDragAppOutOfFolder = useCallback((folderId: string, appId: string, clientX: number, clientY: number) => {
    const folderPage = findFolderPage(folderId);
    if (folderPage < 0) return; // 文件夹可能已在拖拽期间被移除。
    const withoutApp = pagesRef.current.map((page, index) =>
      index === folderPage ? removeAppFromFolder(page, folderId, appId) : page);
    const target = activePageIndexRef.current;
    const cell = cellFromPoint(target, clientX, clientY, 1, 1);
    const next = addItemToPageOrInsert(withoutApp, target, { kind: 'app', refId: appId, ...cell });
    if (next === withoutApp) return;
    commitPages(next);
    setOpenFolderId(null);
    trackEvent('桌面从文件夹移出应用');
  }, [activePageIndexRef, commitPages, cellPx]);

  // 电脑模式：全局方向键翻页（←/→）。
  // 防冲突范围：
  // - 焦点在输入框/textarea/select/contenteditable 时不接管，文本光标优先；
  // - 中文输入法组词中（isComposing）不接管，拼音选字要用方向键翻候选词；
  // - 按了 Alt/Ctrl/Cmd 等修饰键不接管，避免拦掉浏览器自己的前进后退等系统手势；
  // - 弹层（组件库/图片选择/四宫格管理/加页菜单/见面全屏）打开时不接管，这些弹层
  //   自己的方向键交互（如果以后加）优先；
  // - 元素标了 [data-no-arrow-nav] 视为自行声明"这里方向键归我管"，同样放行。
  // - 正在拖拽条目（gesture.current 非空）时不接管——拖到边缘自动翻页那套已经在管
  //   了，这时候按方向键跟正在进行的拖拽手势抢页面会打架。
  // 编辑态（layoutEditing）本身不再拦截：用户明确要求整理桌面时也能用方向键翻页，
  // 不用非得把条目拖到屏幕边缘才能翻——只要没在真的拖东西，两套翻页机制不会撞车。
  useEffect(() => {
    if (!isDesktop) return;
    const overlayOpen = galleryOpen || scheduleViewerOpen || !!imagePicker || !!quadManagerTarget || !!openFolderId || addPageMenu !== null;
    if (overlayOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
      if (gesture.current?.active) return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if (target.closest('[data-no-arrow-nav]')) return;
      }
      e.preventDefault();
      jumpToPage(activePageIndexRef.current + (e.key === 'ArrowLeft' ? -1 : 1));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, galleryOpen, scheduleViewerOpen, imagePicker, quadManagerTarget, openFolderId, addPageMenu, jumpToPage]);

  const handleRemoveQuadApp = useCallback((pageIndex: number, itemId: string, slotIndex: number) => {
    const page = pagesRef.current[pageIndex];
    if (!page) return;
    const targetItem = page.items.find(i => i.id === itemId);
    if (!targetItem) return;
    const currentApps: (string | null)[] = Array.isArray(targetItem.config?.apps)
      ? [0, 1, 2, 3].map(i => targetItem.config?.apps[i] ?? null)
      : [null, null, null, null];
    currentApps[slotIndex] = null;
    replacePage(pageIndex, {
      ...page,
      items: page.items.map(it => it.id === itemId ? {
        ...it,
        config: { ...(it.config || {}), apps: currentApps }
      } : it)
    });
    trackEvent('四宫格移除应用');
  }, [replacePage]);

  const handleSelectQuadApp = useCallback((pageIndex: number, itemId: string, slotIndex: number, appId: string) => {
    // 1. 如果该 appId 已经在其它页面的普通 1×1 app 条目中，则将其从原位置移除（收纳进四宫格）
    let currentPages = pagesRef.current.map(p => ({
      ...p,
      items: p.items.filter(it => !(it.kind === 'app' && it.refId === appId))
    }));

    // 2. 将 appId 放入目标 quad_apps 的 slotIndex
    const targetPage = currentPages[pageIndex];
    if (!targetPage) return;
    const targetItem = targetPage.items.find(i => i.id === itemId);
    if (!targetItem) return;

    const currentApps: (string | null)[] = Array.isArray(targetItem.config?.apps)
      ? [0, 1, 2, 3].map(i => targetItem.config?.apps[i] ?? null)
      : [null, null, null, null];
    currentApps[slotIndex] = appId;

    currentPages = currentPages.map((p, i) => i === pageIndex ? {
      ...p,
      items: p.items.map(it => it.id === itemId ? {
        ...it,
        config: { ...(it.config || {}), apps: currentApps }
      } : it)
    } : p);

    commitPages(currentPages);
    trackEvent('四宫格添加应用');
  }, [commitPages]);

  // ───────── 主题派生 ─────────
  const contentColor = theme.contentColor || '#ffffff';
  const acnh = theme.skin === 'animalcrossing';
  const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  const launcherBottomInset = '1.25rem';
  const totalUnread = Object.values(unreadMessages).reduce((a, b) => a + b, 0);
  const widgetUnread = widgetChar && unreadMessages[widgetChar.id] ? unreadMessages[widgetChar.id] : 0;

  const widgetCtx: WidgetRenderContext = useMemo(() => ({
    contentColor, acnh, paper, editing: layoutEditing,
    openApp: (id: string) => { if (!layoutEditing) openApp(id as AppID); },
    anniversaries, tasks, characters,
    widgetChar,
    scheduleData, scheduleChar,
    onOpenSchedule: () => {
      if (layoutEditing) return;
      setScheduleViewerOpen(true);
      trackEvent('打开角色日程面板');
    },
    onEditImage: openImagePicker,
    onUpdateItemConfig: handleUpdateItemConfig,
    onOpenQuadManager: handleOpenQuadManager,
    onOpenFolder: handleOpenFolder,
    widgetOpacity: theme.widgetOpacity,
    appIconSizePx: Math.max(40, Math.min(60, cellHeightFor(cellPx) - APP_ICON_VERTICAL_RESERVE)),
  }), [
    contentColor, acnh, paper, layoutEditing, openApp,
    anniversaries, tasks, characters, widgetChar,
    scheduleData, scheduleChar, openImagePicker,
    handleOpenQuadManager, handleOpenFolder, handleUpdateItemConfig, theme.widgetOpacity, cellPx,
  ]);

  const dockAppsConfig = useMemo(() => {
    const byId = new Map(getInstalledAppDefinitions(APP_REGISTRY).map(app => [app.id, app]));
    const order = dockAppIds;
    return order.map(id => byId.get(id as AppID)).filter(Boolean) as DesktopAppDefinition[];
  }, [dockAppIds]);

  // 皮肤分流（独立组件自渲染）
  if (theme.skin === 'mobilegame') return <MobileGameHome />;
  if (theme.skin === 'tamagotchi') return <TamagotchiHome />;
  if (theme.skin === 'companion') {
    return (
      <React.Suspense fallback={<div className="h-full w-full bg-[#100d1c]" />}>
        <CompanionHome />
      </React.Suspense>
    );
  }



  return (
    <div
      data-launcher-root
      className="h-full w-full flex flex-col relative z-10 overflow-hidden font-sans select-none"
      onPointerDownCapture={onRootPointerDownCapture}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onRootPointerMove}
      onPointerUp={onRootPointerUp}
      onPointerCancel={onRootPointerUp}
      onLostPointerCapture={e => {
        if (e.target === e.currentTarget && gesture.current?.pointerId === e.pointerId) onRootPointerUp(e);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-grid-item], [data-dock-app]')) e.preventDefault();
      }}
    >
      <style>{`
        .launcher-drag-ghost { opacity:.96; filter: drop-shadow(0 12px 14px rgba(75,65,54,.18)); }
        .launcher-edit-wobble { animation: launcherWobble 2.4s ease-in-out infinite; transform-origin: 50% 50%; }
        @keyframes launcherWobble { 0%,100%{transform:rotate(-0.6deg)} 50%{transform:rotate(0.6deg)} }
        /* 长按预警：还没到「进入整理态」的临界点，先给个「快松手」的信号 */
        .launcher-press-warn { transition: transform 160ms ease, filter 160ms ease, opacity 160ms ease; transform: scale(0.88); filter: brightness(0.8); opacity: 0.85; }
        /* 拖拽落点候选框浮现微弹动画 */
        .launcher-drag-placeholder { animation: launcherPlaceholderPop 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2); }
        @keyframes launcherPlaceholderPop { 0% { opacity: 0.2; transform: scale(0.92); } 100% { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) {
          .launcher-edit-wobble, .launcher-drag-placeholder { animation: none; }
          .launcher-press-warn { transition: none; }
        }
      `}</style>

      {layoutEditing && (
        <div className="absolute bottom-[calc(var(--safe-bottom)+8rem)] left-5 right-5 z-50 flex items-center justify-between pointer-events-none">
          <button
            onClick={() => { setGalleryInitialTab('widgets'); setGalleryOpen(true); }}
            className="pointer-events-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold backdrop-blur-xl border shadow-lg active:scale-95 transition"
            style={{
              background: paper ? 'rgba(224,221,215,0.75)' : acnh ? 'rgba(250,246,236,0.85)' : 'rgba(255,255,255,0.65)',
              color: paper ? '#4a3e31' : acnh ? '#725d42' : '#1e293b',
              borderColor: paper ? 'rgba(91,72,51,0.15)' : acnh ? '#e8e2d6' : 'rgba(255,255,255,0.5)',
            }}
          >
            <Plus size={14} weight="bold" /><span>添加组件 / 应用</span>
          </button>
          <button
            onClick={finishEditing}
            className="pointer-events-auto px-4 py-1.5 rounded-full text-xs font-bold shadow-lg active:scale-95 transition backdrop-blur-xl border"
            style={{ background: paper ? '#788369' : acnh ? '#19c8b9' : '#0f172a', color: '#fff', borderColor: 'rgba(255,255,255,0.2)' }}
          >
            完成
          </button>
        </div>
      )}


      {!acnh && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(255,255,255,0.22) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)' }} />
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(123,104,78,0.06) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%)' }} />
        </div>
      )}

      {/* 桌面自由摆放装饰（贴纸），铺满整个滚动区上方 */}
      {theme.desktopDecorations && theme.desktopDecorations.length > 0 && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-[5]">
          {theme.desktopDecorations.map(deco => (
            <img
              key={deco.id} src={deco.content} alt="" loading="lazy"
              className="absolute w-16 h-16 object-contain select-none"
              style={{
                left: `${deco.x}%`, top: `${deco.y}%`,
                transform: `translate(-50%, -50%) scale(${deco.scale}) rotate(${deco.rotation}deg)${deco.flip ? ' scaleX(-1)' : ''}`,
                opacity: deco.opacity, zIndex: deco.zIndex,
                filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))',
              }}
            />
          ))}
        </div>
      )}

      {/* 横向翻页容器 */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onPointerDown={handleMouseDown}
        onClickCapture={handleClickCapture}
        className={`flex-1 flex overflow-x-auto overflow-y-hidden no-scrollbar cursor-grab active:cursor-grabbing ${initialScrollDone ? 'snap-x snap-mandatory' : ''}`}
        style={{
          // 直接拖动时会高频写 scrollLeft，不能被全局 smooth 插值；跳页处会显式 smooth。
          scrollBehavior: 'auto',
          overscrollBehaviorX: 'contain',
          overscrollBehaviorY: 'none',
          touchAction: 'pan-x',
          willChange: 'scroll-position',
          contain: 'layout paint',
          transform: 'translateZ(0)',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {pages.map((page, pageIndex) => (
          <DesktopPageView
            key={page.id}
            page={page}
            pageIndex={pageIndex}
            gridWidthPx={gridWidthPx}
            cellPx={cellPx}
            layoutEditing={layoutEditing}
            widgetCtx={widgetCtx}
            onItemPointerDown={onItemPointerDown}
            handleToggleLock={handleToggleLock}
            handleDeleteItem={handleDeleteItem}
            onResizePointerDown={onResizePointerDown}
            dragPreview={dragDockAppId === null ? dragPreview : null}
            registerPageGridRef={registerPageGridRef}
            widgetChar={widgetChar}
            widgetUnread={widgetUnread}
            lastMessage={lastMessage}
            onOpenChat={handleOpenChat}
            contentColor={contentColor}
            paper={paper}
            dockDropPreview={dragDockAppId === null ? null : dragPreview}
          />
        ))}
      </div>

      {/* 页码点 */}
      <PageIndicators
        totalPages={totalPages}
        activePageIndex={activePageIndex}
        contentColor={contentColor}
        bottomInset={launcherBottomInset}
        onJumpToPage={jumpToPage}
      />

      {/* 编辑态：当前页控件（起始页 / 增删页），放在固定栏与网格之间，方便单手点击 */}
      {layoutEditing && (() => {
        const curPage = pages[activePageIndex];
        if (!curPage) return null;
        const isStart = theme.launcherStartPageId
          ? theme.launcherStartPageId === curPage.id
          : curPage.layout === 'home';
        return (
          <div className="relative z-30 flex items-center justify-center gap-2 pb-2">
            <button
              onClick={() => handleSetStartPage(curPage.id)}
              className={`px-3 py-1 rounded-full text-[11px] font-bold flex items-center gap-1 shadow-lg active:scale-95 backdrop-blur-xl border ${
                isStart ? 'bg-amber-400 text-slate-900 border-amber-300' : 'bg-white/70 text-slate-800 border-white/50'
              }`}
              title={isStart ? '当前起始页 · 再点取消' : '把「第 ' + (activePageIndex + 1) + ' 页」设为开机起始页'}
            >
              <House size={12} weight={isStart ? 'fill' : 'regular'} />
              {isStart ? '起始页 ✓' : '设为起始页'}
            </button>
            {curPage.layout !== 'home' && curPage.items.length === 0 && pages.length > 1 && (
              <button
                onClick={() => handleRemovePage(activePageIndex)}
                className="px-3 py-1 rounded-full text-[11px] font-bold bg-red-500/85 text-white flex items-center gap-1 shadow-lg active:scale-95"
              >
                <X size={12} weight="bold" />移除空页
              </button>
            )}
            {(['left', 'right'] as const).map(direction => (
              <div key={direction} className="relative">
                <button
                  onClick={() => setAddPageMenu(m => (m === direction ? null : direction))}
                  title={direction === 'left' ? '在当前页左边插入新页' : '在当前页右边插入新页'}
                  className="px-3 py-1 rounded-full text-[11px] font-bold bg-white/70 text-slate-800 flex items-center gap-1 shadow-lg active:scale-95 backdrop-blur-xl border border-white/50"
                >
                  {direction === 'left'
                    ? <><CaretLeft size={12} weight="bold" /><Plus size={12} weight="bold" /></>
                    : <><Plus size={12} weight="bold" /><CaretRight size={12} weight="bold" /></>}
                </button>
                {addPageMenu === direction && (
                  <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 flex flex-col gap-1 p-1.5 rounded-2xl bg-white/95 backdrop-blur-xl border border-white/50 shadow-xl z-40 whitespace-nowrap">
                    <button
                      onClick={() => { handleAddPage(direction); setAddPageMenu(null); }}
                      className="px-3 py-1.5 rounded-xl text-[11px] font-bold text-slate-800 hover:bg-slate-100 active:scale-95 text-left"
                    >
                      标准页 · 4×7
                    </button>
                    <button
                      onClick={() => { handleAddPage(direction, 'windmill'); setAddPageMenu(null); }}
                      className="px-3 py-1.5 rounded-xl text-[11px] font-bold text-slate-800 hover:bg-slate-100 active:scale-95 text-left"
                    >
                      风车页 · 4×6
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Dock */}
      <LauncherDock
        dockApps={dockAppsConfig}
        totalUnread={totalUnread}
        openApp={openApp}
        acnh={acnh}
        paper={paper}
        bottomInset={launcherBottomInset}
        layoutEditing={layoutEditing}
        onRemoveFromDock={handleRemoveFromDock}
        onDragStart={onDockPointerDown}
        dragAppId={dragDockAppId}
        dropActive={dockDropActive}
      />

      <ScheduleFullscreenViewer
        open={scheduleViewerOpen}
        onClose={() => setScheduleViewerOpen(false)}
        characters={characters}
        activeCharId={scheduleChar?.id || null}
        onSwitchCharacter={(id) => setScheduleCharId(id)}
        schedule={scheduleData}
        activeCharacter={scheduleChar}
        contentColor={contentColor}
      />

      <DesktopGalleryModal
        isOpen={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onAddWidget={(kind) => handleAddToCurrentPage({ kind })}
        onAddApp={(appId) => handleAddToCurrentPage({ kind: 'app', refId: appId })}
        existingKinds={existingKinds}
        placedAppIds={placedAppIds}
        dockAppIds={dockAppIds}
        onMoveAppToDock={handleMoveAppToDock}
        targetLabel={`到第 ${activePageIndex + 1} 页`}
        initialTab={galleryInitialTab}
        acnh={acnh}
        paper={paper}
      />

      <ImagePickerModal
        isOpen={!!imagePicker}
        currentSrc={imagePicker?.src}
        onSave={(src) => { if (imagePicker) setItemConfigSrc(imagePicker.pageIndex, imagePicker.itemId, src); }}
        onClose={() => setImagePicker(null)}
        acnh={acnh}
        paper={paper}
      />

      {openFolderId && (() => {
        const folder = pages.flatMap(pg => pg.items).find(it => it.id === openFolderId && it.kind === FOLDER_KIND);
        if (!folder) return null;
        return (
          <AppFolderOverlay
            folder={folder}
            acnh={acnh}
            paper={paper}
            contentColor={contentColor}
            onClose={() => setOpenFolderId(null)}
            onOpenApp={(appId) => {
              if (layoutEditing) return;
              setOpenFolderId(null);
              openApp(appId as AppID);
            }}
            onRename={(name) => handleRenameFolder(folder.id, name)}
            onReorder={(apps) => handleReorderFolder(folder.id, apps)}
            onDragOut={(appId, x, y) => handleDragAppOutOfFolder(folder.id, appId, x, y)}
          />
        );
      })()}

      {quadManagerTarget && (() => {
        const page = pages[quadManagerTarget.pageIndex];
        const item = page?.items.find(i => i.id === quadManagerTarget.itemId);
        if (!item) return null;
        return (
          <QuadAppPickerModal
            isOpen={true}
            onClose={() => setQuadManagerTarget(null)}
            onSelectApp={(appId, slotIdx) => handleSelectQuadApp(quadManagerTarget.pageIndex, item.id, slotIdx, appId)}
            onRemoveApp={(slotIdx) => handleRemoveQuadApp(quadManagerTarget.pageIndex, item.id, slotIdx)}
            slotIndex={quadManagerTarget.slotIndex}
            placedAppIds={placedAppIds}
            dockAppIds={dockAppIds}
            currentQuadAppIds={item.config?.apps}
            acnh={acnh}
            paper={paper}
          />
        );
      })()}
    </div>
  );
};

export default Launcher;

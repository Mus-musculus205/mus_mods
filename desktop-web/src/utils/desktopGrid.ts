/**
 * 自由网格桌面（Android 式）—— 纯逻辑层，不碰 UI。
 *
 * 模型：每页是 GRID_COLS × GRID_ROWS 的格子矩阵；App 与小组件都是 PlacedItem，
 * 按 (x,y,w,h) 摆在格子上，允许任意留空。由 DesktopLayout 统一管理页面与 Dock。
 *
 * 所有 page 操作都返回**新对象**（不改入参），方便 React setState / 撤销。
 */
import type { DesktopPage, DesktopLayout, PlacedItem, GridItemKind, WidgetKind } from '../registry/widgets/layout';
import {
    getWidgetDefaultSize,
    getWidgetSizeLimits,
    isWidgetDefaultLocked,
    isWidgetKind,
    isWidgetSingleton,
} from '../registry/widgets';
import { makeItemId, makePageId } from './desktopIds';
import { FOLDER_KIND, normalizeFolderItem, readFolderConfig } from './desktopFolders';

export const GRID_COLS = 4;
/** 普通页的最大行数；风车页和首页通过 rowsForScreen 使用更小的容量。 */
export const GRID_ROWS = 7;

/**
 * 主屏（Screen 1）表头下面的网格只有这么高：时钟+角色卡占了大半屏，硬塞 GRID_ROWS
 * 行会把每行压得很扁（组件截断、圆角看着像被切掉）。所以主屏单独给一个更小的行数，
 * 行高和其它页保持一致（不挤压）。
 */
export const HOME_PAGE_ROWS = 2;
export const WINDMILL_PAGE_ROWS = 6;
export const APP_PAGE_ROWS = 7;

/**
 * 某个页面的网格行数只由 page.layout 决定。
 */
export const rowsForScreen = (page: DesktopPage): number => {
    if (page.layout === 'home') return HOME_PAGE_ROWS;
    if (page.layout === 'windmill') return WINDMILL_PAGE_ROWS;
    return APP_PAGE_ROWS;
};

/** 主屏在 pages 数组里的下标；不存在时返回 -1。 */
export const findHomeIndex = (pages: DesktopPage[]): number =>
    pages.findIndex(page => page.layout === 'home');

// id 生成放在独立小模块里，文件夹逻辑（desktopFolders）也要用，避免两边互相 import。
export { makeItemId, makePageId };

// ───────────────────────── 几何 ─────────────────────────

type Rect = { x: number; y: number; w: number; h: number };

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const withinGrid = (
    r: Rect,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): boolean =>
    Number.isInteger(r.x) && Number.isInteger(r.y) &&
    Number.isInteger(r.w) && Number.isInteger(r.h) &&
    r.w > 0 && r.h > 0 &&
    r.x >= 0 && r.y >= 0 &&
    r.x + r.w <= cols && r.y + r.h <= rows;

/**
 * rect 能否放进 page：在网格内，且不与其它条目重叠。
 * ignoreId：移动 / 改大小时忽略条目自身。
 */
export const canPlace = (
    page: DesktopPage,
    rect: Rect,
    ignoreId?: string,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): boolean => {
    if (!withinGrid(rect, cols, rows)) return false;
    return !page.items.some(it => it.id !== ignoreId && rectsOverlap(it, rect));
};

/** 行优先扫描，返回第一个能放下 w×h 的左上角坐标；放不下返回 null。 */
export const findFreeRect = (
    page: DesktopPage,
    w: number,
    h: number,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): { x: number; y: number } | null => {
    if (w <= 0 || h <= 0 || w > cols || h > rows) return null;
    for (let y = 0; y + h <= rows; y++) {
        for (let x = 0; x + w <= cols; x++) {
            if (canPlace(page, { x, y, w, h }, undefined, cols, rows)) return { x, y };
        }
    }
    return null;
};

export interface DisplacementResult {
    ok: boolean;
    displacedItems: Map<string, { x: number; y: number }>;
}

/**
 * 尝试将目标区域 rect 放置在 page 中并挤开原本在该位置的条目：
 * - 若 rect 越界，返回 null。
 * - 若无重叠，返回 { ok: true, displacedItems: Map() }。
 * - 若碰撞条目中包含锁定条目（locked），返回 null（锁定项不可挤开）。
 * - 为所有被碰撞的条目寻找离其最近的可用空格（优先相邻格子及拖拽项腾出的原位置）。
 * - 若所有碰撞条目均成功找到新空位，返回 { ok: true, displacedItems }。
 * - 若网格无足够空位安放被碰撞条目，返回 null。
 */
export const tryDisplace = (
    page: DesktopPage,
    rect: Rect,
    ignoreId?: string,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): DisplacementResult | null => {
    if (!withinGrid(rect, cols, rows)) return null;

    const colliding = page.items.filter(it => it.id !== ignoreId && rectsOverlap(it, rect));
    if (colliding.length === 0) {
        return { ok: true, displacedItems: new Map() };
    }

    if (colliding.some(it => it.locked)) {
        return null;
    }

    const collidingIds = new Set(colliding.map(c => c.id));
    const occupiedByOthers: Rect[] = page.items
        .filter(it => it.id !== ignoreId && !collidingIds.has(it.id))
        .map(it => ({ x: it.x, y: it.y, w: it.w, h: it.h }));

    occupiedByOthers.push(rect);

    const displacedItems = new Map<string, { x: number; y: number }>();
    const currentOccupied = [...occupiedByOthers];

    const sortedColliding = [...colliding].sort((a, b) => (b.w * b.h - a.w * a.h) || a.y - b.y || a.x - b.x);

    const ignoreItem = ignoreId ? page.items.find(it => it.id === ignoreId) : undefined;

    for (const item of sortedColliding) {
        const candidates: { x: number; y: number; dist: number }[] = [];

        for (let y = 0; y + item.h <= rows; y++) {
            for (let x = 0; x + item.w <= cols; x++) {
                const candidateRect: Rect = { x, y, w: item.w, h: item.h };
                const overlaps = currentOccupied.some(occ => rectsOverlap(occ, candidateRect));
                if (!overlaps) {
                    const dx = x - item.x;
                    const dy = y - item.y;
                    let dirBonus = 0.005;
                    if (dx > 0 && dy === 0) dirBonus = 0.001; // 右
                    else if (dx === 0 && dy > 0) dirBonus = 0.002; // 下
                    else if (dx < 0 && dy === 0) dirBonus = 0.003; // 左
                    else if (dx === 0 && dy < 0) dirBonus = 0.004; // 上

                    // 1. 同尺寸直接重叠互换（1:1 swap）：若该位置是被拖拽项腾出的原位置且尺寸一致，给予最高优先级直接对调
                    const isDirectSwap = Boolean(
                        ignoreItem &&
                        x === ignoreItem.x &&
                        y === ignoreItem.y &&
                        item.w === ignoreItem.w &&
                        item.h === ignoreItem.h
                    );

                    // 2. 落入拖拽项腾出的区域（如 2×2 组件腾出空间供其它被撞条目填补）
                    const isVacatedArea = Boolean(
                        ignoreItem &&
                        !isDirectSwap &&
                        rectsOverlap(ignoreItem, candidateRect)
                    );

                    let swapBonus = 0;
                    if (isDirectSwap) {
                        swapBonus = -100;
                    } else if (isVacatedArea) {
                        swapBonus = -10;
                    }

                    // 使用欧几里得距离，确保物理几何距离最近的可用空位（斜对角相邻 1.414 优先于隔两格 2.0）
                    const dist = Math.hypot(dx, dy) + dirBonus + swapBonus;
                    candidates.push({ x, y, dist });
                }
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        candidates.sort((a, b) => a.dist - b.dist);
        const best = candidates[0];

        displacedItems.set(item.id, { x: best.x, y: best.y });
        currentOccupied.push({ x: best.x, y: best.y, w: item.w, h: item.h });
    }

    return { ok: true, displacedItems };
};

/**
 * 将挤开位移应用到页面条目中
 */
export const applyDisplacements = (
    page: DesktopPage,
    displacements?: Map<string, { x: number; y: number }>,
): DesktopPage => {
    if (!displacements || displacements.size === 0) return page;
    return {
        ...page,
        items: page.items.map(it => {
            const pos = displacements.get(it.id);
            return pos ? { ...it, x: pos.x, y: pos.y } : it;
        }),
    };
};

// ───────────────────────── 单页操作 ─────────────────────────

export const emptyPage = (
    id: string = makePageId(),
    layout: 'windmill' | 'standard' | 'home' = 'standard',
): DesktopPage => ({
    id,
    items: [],
    layout,
});

export interface NewItemSpec {
    kind: GridItemKind;
    refId?: string;
    w?: number;
    h?: number;
    locked?: boolean;
    title?: string;
    config?: Record<string, any>;
    /** 指定落点；不传或放不下则自动找空位。 */
    x?: number;
    y?: number;
}

/** 执行 Widget Registry 声明的尺寸契约；不持有任何尺寸 metadata。 */
const normalizeItemSize = (
    kind: GridItemKind,
    w?: unknown,
    h?: unknown,
): { w: number; h: number } => {
    if (kind === 'app') return { w: 1, h: 1 };

    const defaults = getWidgetDefaultSize(kind);
    const limits = getWidgetSizeLimits(kind);
    if (!limits) return defaults;

    const normalizeDimension = (value: unknown, fallback: number, min: number, max: number): number =>
        typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
            ? Math.max(min, Math.min(max, value))
            : fallback;

    return {
        w: normalizeDimension(w, defaults.w, limits.min.w, limits.max.w),
        h: normalizeDimension(h, defaults.h, limits.min.h, limits.max.h),
    };
};

/**
 * 往页里加一个条目。返回 { page, item }（新页 + 新条目），整页放不下返回 null。
 */
export const addItem = (
    page: DesktopPage,
    spec: NewItemSpec,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): { page: DesktopPage; item: PlacedItem } | null => {
    const { w, h } = normalizeItemSize(spec.kind, spec.w, spec.h);
    const locked = spec.locked ?? (spec.kind === 'app' ? false : isWidgetDefaultLocked(spec.kind));

    let pos: { x: number; y: number } | null = null;
    if (spec.x != null && spec.y != null && canPlace(page, { x: spec.x, y: spec.y, w, h }, undefined, cols, rows)) {
        pos = { x: spec.x, y: spec.y };
    } else {
        pos = findFreeRect(page, w, h, cols, rows);
    }
    if (!pos) return null;

    const item: PlacedItem = {
        id: makeItemId(spec.kind),
        kind: spec.kind,
        ...(spec.refId != null ? { refId: spec.refId } : {}),
        x: pos.x, y: pos.y, w, h,
        locked,
        ...(spec.title != null ? { title: spec.title } : {}),
        ...(spec.config != null ? { config: spec.config } : {}),
    };
    return { page: { ...page, items: [...page.items, item] }, item };
};

/** 尽量放在指定页。若整页已满，在其后插入普通页并从第一个空位开始摆放。 */
export const addItemToPageOrInsert = (pages: DesktopPage[], pageIndex: number, spec: NewItemSpec): DesktopPage[] => {
    const page = pages[pageIndex];
    if (!page) return pages;

    const placed = addItem(page, spec, GRID_COLS, rowsForScreen(page));
    if (placed) return pages.map((current, index) => index === pageIndex ? placed.page : current);

    const fresh = emptyPage(undefined, 'standard');
    const overflow = addItem(fresh, { ...spec, x: undefined, y: undefined }, GRID_COLS, rowsForScreen(fresh));
    return overflow
        ? [...pages.slice(0, pageIndex + 1), overflow.page, ...pages.slice(pageIndex + 1)]
        : pages;
};

export const removeItem = (page: DesktopPage, itemId: string): DesktopPage =>
    ({ ...page, items: page.items.filter(it => it.id !== itemId) });

/** 移动条目到 (x,y)。放不下（越界 / 撞其它条目）返回原页不变。 */
export const moveItem = (
    page: DesktopPage,
    itemId: string,
    x: number,
    y: number,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): DesktopPage => {
    const it = page.items.find(i => i.id === itemId);
    if (!it) return page;
    if (!canPlace(page, { x, y, w: it.w, h: it.h }, itemId, cols, rows)) return page;
    return { ...page, items: page.items.map(i => i.id === itemId ? { ...i, x, y } : i) };
};

/** 改大小（左上角不动）。放不下返回原页不变。 */
export const resizeItem = (
    page: DesktopPage,
    itemId: string,
    w: number,
    h: number,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): DesktopPage => {
    const it = page.items.find(i => i.id === itemId);
    if (!it) return page;
    const size = normalizeItemSize(it.kind, w, h);
    if (!canPlace(page, { x: it.x, y: it.y, ...size }, itemId, cols, rows)) return page;
    return { ...page, items: page.items.map(i => i.id === itemId ? { ...i, ...size } : i) };
};

export const toggleLock = (page: DesktopPage, itemId: string): DesktopPage =>
    ({ ...page, items: page.items.map(i => i.id === itemId ? { ...i, locked: !i.locked } : i) });

// ───────────────────────── 跨页操作 ─────────────────────────

/**
 * 把一串条目规格顺序铺进若干页：当前页放不下就开新页。
 * 用于批量铺放、溢出重排与默认布局构建。startPages 里已有的条目会被绕开。
 */
export const flowItems = (
    startPages: DesktopPage[],
    specs: NewItemSpec[],
    cols: number = GRID_COLS,
    /** 每页行数：固定数字，或由页面角色计算。 */
    rowsFor: number | ((page: DesktopPage) => number) = GRID_ROWS,
): DesktopPage[] => {
    const rowsAt = (page: DesktopPage) => typeof rowsFor === 'function' ? rowsFor(page) : rowsFor;
    const pages = startPages.length ? startPages.map(p => ({ ...p, items: [...p.items] })) : [emptyPage()];
    let pi = 0;
    for (const spec of specs) {
        // 从当前页往后找第一个放得下的页
        let placed = false;
        while (pi < pages.length) {
            const res = addItem(pages[pi], spec, cols, rowsAt(pages[pi]));
            if (res) { pages[pi] = res.page; placed = true; break; }
            pi++;
        }
        if (!placed) {
            const fresh = emptyPage(makePageId(), 'standard');
            const res = addItem(fresh, spec, cols, rowsAt(fresh));
            pages.push(res ? res.page : fresh);
            pi = pages.length - 1;
        }
    }
    return pages;
};

export const addPage = (pages: DesktopPage[], layout: 'windmill' | 'standard' = 'standard'): DesktopPage[] =>
    [...pages, emptyPage(makePageId(), layout)];

/** 按阅读顺序（先 y 后 x）把条目重新贴到左上角，去掉空洞。锁定项也一起重排。 */
export const compactPage = (
    page: DesktopPage,
    cols: number = GRID_COLS,
    rows: number = GRID_ROWS,
): DesktopPage => {
    const sorted = [...page.items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let out: DesktopPage = { ...page, items: [] };
    for (const it of sorted) {
        const pos = findFreeRect(out, it.w, it.h, cols, rows);
        out = { ...out, items: [...out.items, pos ? { ...it, x: pos.x, y: pos.y } : it] };
    }
    return out;
};



/**
 * 主屏行数为 HOME_PAGE_ROWS：把持久布局中落在范围之外的条目挪到后面的页，
 * 而不是裁掉。
 */
export const enforceHomeRowCap = (pages: DesktopPage[]): DesktopPage[] => {
    const homeIdx = findHomeIndex(pages);
    if (homeIdx < 0) return pages;
    const home = pages[homeIdx];
    const overflow = home.items.filter(it => it.y + it.h > HOME_PAGE_ROWS || it.x + it.w > GRID_COLS);
    if (overflow.length === 0) return pages;
    const kept = home.items.filter(it => !overflow.includes(it));
    const newHome = { ...home, items: kept };
    const overflowSpecs: NewItemSpec[] = overflow.map(it => ({
        kind: it.kind, refId: it.refId, w: it.w, h: it.h, locked: it.locked, title: it.title, config: it.config,
    }));
    const before = pages.slice(0, homeIdx);
    const rest = pages.slice(homeIdx + 1);
    const flowed = flowItems(rest.length ? rest : [emptyPage()], overflowSpecs, GRID_COLS, rowsForScreen);
    return [...before, newHome, ...flowed];
};

/**
 * 通用防重叠 / 越界纠偏。持久布局可能包含重叠坐标或越界条目；按稳定顺序保留
 * 合法位置，并把其余条目移到当前模型允许的空位。
 *
 * 只动真正有问题的条目：按原顺序走一遍，不越界且不跟前面「已确认没问题」
 * 的条目重叠就保留原位；一旦越界或重叠，找该页第一个空位挪过去；实在没空位
 * 的（页面早就该重排了）丢进溢出队列，顺流铺到后面的页。没问题的数据完全
 * 不挪动，不会无意义打乱用户摆好的布局。
 */
export const repairOverlaps = (pages: DesktopPage[]): DesktopPage[] => {
    let anyChanged = false;
    const overflowSpecs: NewItemSpec[] = [];
    const repaired = pages.map(page => {
        const rows = rowsForScreen(page);
        const kept: PlacedItem[] = [];
        for (const it of page.items) {
            const ok = withinGrid(it, GRID_COLS, rows) && !kept.some(k => rectsOverlap(k, it));
            if (ok) { kept.push(it); continue; }
            anyChanged = true;
            const pos = findFreeRect({ id: page.id, items: kept, layout: page.layout }, it.w, it.h, GRID_COLS, rows);
            if (pos) {
                kept.push({ ...it, x: pos.x, y: pos.y });
            } else {
                overflowSpecs.push({
                    kind: it.kind, refId: it.refId, w: it.w, h: it.h,
                    locked: it.locked, title: it.title, config: it.config,
                });
            }
        }
        return { ...page, items: kept };
    });
    if (!anyChanged) return pages;
    if (overflowSpecs.length === 0) return repaired;
    return flowItems(repaired, overflowSpecs, GRID_COLS, rowsForScreen);
};

/** 删除某页。至少保留 1 页，且唯一 home page 不允许删除。 */
export const removePage = (pages: DesktopPage[], index: number): DesktopPage[] => {
    if (index < 0 || index >= pages.length || pages.length <= 1) return pages;
    if (pages[index].layout === 'home') return pages;
    return pages.filter((_, i) => i !== index);
};

// ───────────────────────── 默认布局 / 工厂 ─────────────────────────

/**
 * 创建新安装 / 缺失布局时的默认桌面布局（纯 current-only 工厂）。
 *
 * 结构：
 * - Page 0: 负一屏（标准 4x7，初始为空，供用户自由放 App / Widget）
 * - Page 1: 主屏（layout: 'home'，时钟 + 角色卡由 Header 渲染；网格铺前 8 个 App）
 * - Page 2: 风车页（layout: 'windmill'，日程 + 音乐 + 四宫格A + 四宫格B + 相框）
 * - Page 3+: 剩余 App 顺流铺进后续标准页
 * - Dock: App Registry 的默认 Dock App（最多 4 个），与网格 App 互斥
 */
export const createDefaultDesktopLayout = (
    validAppIds: Set<string>,
    defaultDockAppIds: readonly string[],
): DesktopLayout => {
    const dock = uniqueValidAppIds(defaultDockAppIds, validAppIds, DESKTOP_DOCK_CAPACITY);
    const gridAppIds = new Set([...validAppIds].filter(id => !dock.includes(id)));
    const dedupedAppIds = Array.from(gridAppIds);

    // ── Page 0：负一屏 ──
    const page0 = emptyPage(makePageId(), 'standard');

    // ── Page 1：主屏（时钟 + 角色卡是表头；app 从顶格铺起，最多 8 个）──
    let page1 = emptyPage(makePageId(), 'home');
    const page1Apps = dedupedAppIds.slice(0, 8);
    for (const id of page1Apps) {
        const res = addItem(page1, { kind: 'app', refId: id });
        if (res) page1 = res.page;
    }

    // ── Page 2：风车页（日程 + 音乐 + 四宫格A + 四宫格B + 相框）──
    let page2 = emptyPage(makePageId(), 'windmill');
    page2 = (addItem(page2, { kind: 'schedule', x: 0, y: 0 }) || { page: page2 }).page;
    page2 = (addItem(page2, { kind: 'music', x: 0, y: 2 }) || { page: page2 }).page;

    const quadAApps = dedupedAppIds.slice(8, 12);
    const quadBApps = dedupedAppIds.slice(12, 16);

    if (quadAApps.length > 0) {
        page2 = (addItem(page2, {
            kind: 'quad_apps', x: 2, y: 2,
            config: { apps: quadAApps },
        }) || { page: page2 }).page;
    }

    if (quadBApps.length > 0) {
        page2 = (addItem(page2, {
            kind: 'quad_apps', x: 0, y: 4,
            config: { apps: quadBApps },
        }) || { page: page2 }).page;
    }

    page2 = (addItem(page2, { kind: 'image', x: 2, y: 4 }) || { page: page2 }).page;

    // ── 剩余 app 顺流铺进 Page 3+（每页 7 行）──
    const remainingAppIds = dedupedAppIds.slice(16);
    const appSpecs: NewItemSpec[] = remainingAppIds.map(id => ({ kind: 'app' as GridItemKind, refId: id }));

    const pages = flowItems(
        [page1, page2],
        appSpecs,
        GRID_COLS,
        rowsForScreen,
    );

    return normalizeDesktopLayout({
        version: 1,
        pages: [page0, ...pages],
        dock,
    }, validAppIds);
};

/** 网格上所有页里出现过的 AppID（用于算「哪些 app 还没上桌 / 已隐藏」）。 */
export const collectPlacedAppIds = (pages: DesktopPage[]): Set<string> => {
    const s = new Set<string>();
    for (const p of pages) {
        for (const it of p.items) {
            if (it.kind === 'app' && it.refId) s.add(it.refId);
            if (it.kind === 'quad_apps' && Array.isArray(it.config?.apps)) {
                for (const id of it.config.apps) if (id) s.add(id);
            }
            if (it.kind === FOLDER_KIND) {
                for (const id of readFolderConfig(it).apps) s.add(id);
            }
        }
    }
    return s;
};

/**
 * 删除文件夹时把里面的 App 放回桌面：先放文件夹所在页的空位，放不下的接着放进紧跟其后的新页，
 * 不让 App 跟着文件夹一起从桌面消失。
 */
export const dissolveFolderOntoPages = (pages: DesktopPage[], pageIndex: number, folderId: string): DesktopPage[] => {
    const folder = pages[pageIndex]?.items.find(item => item.id === folderId);
    if (!folder || folder.kind !== FOLDER_KIND) throw new Error(`[desktopGrid] 文件夹不存在：${folderId}`);
    let page = removeItem(pages[pageIndex], folderId);
    const overflowPages: DesktopPage[] = [];
    for (const appId of readFolderConfig(folder).apps) {
        const spec: NewItemSpec = { kind: 'app', refId: appId };
        const here = addItem(page, spec, GRID_COLS, rowsForScreen(page));
        if (here) { page = here.page; continue; }
        const lastOverflow = overflowPages[overflowPages.length - 1];
        const there = lastOverflow ? addItem(lastOverflow, spec, GRID_COLS, rowsForScreen(lastOverflow)) : null;
        if (there) { overflowPages[overflowPages.length - 1] = there.page; continue; }
        const fresh = emptyPage(undefined, 'standard');
        overflowPages.push(addItem(fresh, spec, GRID_COLS, rowsForScreen(fresh))!.page);
    }
    return [...pages.slice(0, pageIndex), page, ...overflowPages, ...pages.slice(pageIndex + 1)];
};

// ───────────────────────── 统一布局 / Dock ─────────────────────────

/** Dock 的容量是产品约束，不散落在 UI 组件中。 */
export const DESKTOP_DOCK_CAPACITY = 4;

const uniqueValidAppIds = (ids: readonly string[], validAppIds: Set<string>, limit = Number.POSITIVE_INFINITY): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
        if (!validAppIds.has(id) || seen.has(id) || out.length >= limit) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
};

/** 从网格、四宫格和文件夹中移除指定 App；用于保持 Dock 与页面互斥。 */
export const removeAppsFromPages = (pages: DesktopPage[], appIds: ReadonlySet<string>): DesktopPage[] =>
    pages.map(page => ({
        ...page,
        items: page.items.flatMap(item => {
            if (item.kind === 'app' && item.refId && appIds.has(item.refId)) return [];
            if (item.kind === 'quad_apps' && Array.isArray(item.config?.apps)) {
                const apps = item.config.apps.map(id => typeof id === 'string' && appIds.has(id) ? null : id);
                return [{ ...item, config: { ...item.config, apps } }];
            }
            if (item.kind === FOLDER_KIND) {
                const settled = normalizeFolderItem(item, id => !appIds.has(id));
                return settled ? [settled] : [];
            }
            return [item];
        }),
    }));

/**
 * 规范化桌面布局：清理未知 App、未知小组件、重复项、越界重叠，并保证 Dock / 网格互斥。
 * 正向校验：
 * - app: 必须有合法 refId 且属于 validAppIds
 * - widget: kind 必须满足 isWidgetKind(item.kind)
 * - 其余未知/非法类型直接丢弃
 * - app 强制 1×1；widget 尺寸回退或收敛到 Registry 的 min/max
 * - singleton widget 跨所有页面只保留稳定顺序中的第一个
 * - 页面角色最终恰好包含一个 home
 */
export const normalizeDesktopLayout = (
    layout: DesktopLayout,
    validAppIds: Set<string>,
    dockCapacity: number = DESKTOP_DOCK_CAPACITY,
): DesktopLayout => {
    const dock = uniqueValidAppIds(layout.dock || [], validAppIds, dockCapacity);
    const seenSingletons = new Set<WidgetKind>();
    const cleanedPages = (layout.pages || []).map(page => ({
        ...page,
        layout: page.layout === 'home' || page.layout === 'windmill' || page.layout === 'standard'
            ? page.layout
            : 'standard',
        items: (page.items || []).flatMap(item => {
            if (item.kind === 'app') {
                return item.refId && validAppIds.has(item.refId) ? [{ ...item, w: 1, h: 1 }] : [];
            }
            if (isWidgetKind(item.kind)) {
                if (isWidgetSingleton(item.kind)) {
                    if (seenSingletons.has(item.kind)) return [];
                    seenSingletons.add(item.kind);
                }
                const size = normalizeItemSize(item.kind, item.w, item.h);
                const normalizedItem = {
                    ...item,
                    ...size,
                };
                if (item.kind === 'quad_apps' && Array.isArray(item.config?.apps)) {
                    const apps = item.config.apps.map(id => typeof id === 'string' && validAppIds.has(id) ? id : null);
                    return [{ ...normalizedItem, config: { ...item.config, apps } }];
                }
                if (item.kind === FOLDER_KIND) {
                    const settled = normalizeFolderItem(normalizedItem, id => validAppIds.has(id));
                    return settled ? [settled] : [];
                }
                return [normalizedItem];
            }
            return [];
        }),
    }));
    const pagesWithValidRoles = cleanedPages.length ? cleanedPages : [emptyPage()];
    const firstHomeIndex = pagesWithValidRoles.findIndex(page => page.layout === 'home');
    const pagesWithOneHome = firstHomeIndex < 0
        ? [emptyPage(makePageId(), 'home'), ...pagesWithValidRoles]
        : pagesWithValidRoles.map((page, index) =>
            page.layout === 'home' && index !== firstHomeIndex ? { ...page, layout: 'standard' as const } : page);
    const pages = repairOverlaps(enforceHomeRowCap(
        removeAppsFromPages(pagesWithOneHome, new Set(dock)),
    ));
    return { version: 1, pages, dock };
};

/** 解析当前桌面布局；缺失或异常数据统一回到 current default factory。 */
export const resolveDesktopLayout = (
    layout: DesktopLayout | undefined,
    validAppIds: Set<string>,
    defaultDockAppIds: readonly string[],
    onError?: (error: unknown) => void,
): DesktopLayout => {
    try {
        return layout
            ? normalizeDesktopLayout(layout, validAppIds)
            : createDefaultDesktopLayout(validAppIds, defaultDockAppIds);
    } catch (error) {
        onError?.(error);
        return createDefaultDesktopLayout(validAppIds, defaultDockAppIds);
    }
};

/** 将 App 移入 Dock；Dock 满时返回原布局，不静默挤掉用户已有项目。 */
export const moveAppToDock = (
    layout: DesktopLayout,
    appId: string,
    dockCapacity: number = DESKTOP_DOCK_CAPACITY,
): DesktopLayout => {
    if (!appId || layout.dock.includes(appId)) return layout;
    if (layout.dock.length >= dockCapacity) return layout;
    return {
        ...layout,
        dock: [...layout.dock, appId],
        pages: removeAppsFromPages(layout.pages, new Set([appId])),
    };
};

/** 将 App 从 Dock 放回指定网格页；可指定严格落点，目标无空间时保持原布局。 */
export const moveAppFromDock = (
    layout: DesktopLayout,
    appId: string,
    pageIndex: number,
    target?: { x: number; y: number },
): DesktopLayout => {
    if (!layout.dock.includes(appId) || pageIndex < 0 || pageIndex >= layout.pages.length) return layout;
    const page = layout.pages[pageIndex];
    const rows = rowsForScreen(page);
    if (target && !canPlace(page, { ...target, w: 1, h: 1 }, undefined, GRID_COLS, rows)) return layout;
    const placed = addItem(page, { kind: 'app', refId: appId, ...target }, GRID_COLS, rows);
    if (!placed) return layout;
    return {
        ...layout,
        dock: layout.dock.filter(id => id !== appId),
        pages: layout.pages.map((current, index) => index === pageIndex ? placed.page : current),
    };
};

/** 仅重排现有 Dock App；缺失项保持在尾部，未知项不会写进布局。 */
export const reorderDock = (layout: DesktopLayout, requestedOrder: readonly string[]): DesktopLayout => {
    const requested = uniqueValidAppIds(requestedOrder, new Set(layout.dock));
    const ordered = [
        ...requested,
        ...layout.dock.filter(id => !requested.includes(id)),
    ];
    return ordered.every((id, index) => id === layout.dock[index]) ? layout : { ...layout, dock: ordered };
};

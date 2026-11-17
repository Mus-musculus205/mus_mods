import { describe, it, expect } from 'vitest';
import type { DesktopLayout, DesktopPage, PlacedItem } from '../registry/widgets/layout';
import {
    GRID_COLS, GRID_ROWS, HOME_PAGE_ROWS, WINDMILL_PAGE_ROWS, APP_PAGE_ROWS, rowsForScreen,
    rectsOverlap, withinGrid, canPlace, findFreeRect,
    emptyPage, addItem, addItemToPageOrInsert, removeItem, moveItem, resizeItem, toggleLock,
    flowItems, addPage, removePage, enforceHomeRowCap, repairOverlaps,
    collectPlacedAppIds, tryDisplace, applyDisplacements,
    createDefaultDesktopLayout, normalizeDesktopLayout, resolveDesktopLayout,
    moveAppToDock, moveAppFromDock, reorderDock,
} from './desktopGrid';

const mk = (over: Partial<PlacedItem>): PlacedItem => ({
    id: over.id || 'x', kind: over.kind || 'app', x: 0, y: 0, w: 1, h: 1, ...over,
});
const page = (items: PlacedItem[]): DesktopPage => ({ id: 'p', items, layout: 'standard' });

describe('desktopGrid · 几何', () => {
    it('rectsOverlap', () => {
        expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
        expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 })).toBe(false); // 相邻不算
        expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 0, y: 2, w: 2, h: 2 })).toBe(false);
    });

    it('withinGrid 边界', () => {
        expect(withinGrid({ x: 0, y: 0, w: 4, h: 7 })).toBe(true);
        expect(withinGrid({ x: 3, y: 0, w: 2, h: 1 })).toBe(false); // 右边越界
        expect(withinGrid({ x: 0, y: 6, w: 1, h: 2 })).toBe(false); // 底部越界（GRID_ROWS=7）
        expect(withinGrid({ x: -1, y: 0, w: 1, h: 1 })).toBe(false);
        expect(withinGrid({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
        expect(withinGrid({ x: 0, y: 0, w: 1.5, h: 1 })).toBe(false);
        expect(withinGrid({ x: 0, y: 0, w: 1, h: Number.NaN })).toBe(false);
    });

    it('canPlace 检测重叠与越界，ignoreId 生效', () => {
        const p = page([mk({ id: 'a', x: 0, y: 0, w: 2, h: 2 })]);
        expect(canPlace(p, { x: 2, y: 0, w: 2, h: 2 })).toBe(true);
        expect(canPlace(p, { x: 1, y: 1, w: 1, h: 1 })).toBe(false);
        expect(canPlace(p, { x: 0, y: 0, w: 2, h: 2 }, 'a')).toBe(true); // 忽略自身
    });

    it('findFreeRect 行优先', () => {
        const p = page([mk({ id: 'a', x: 0, y: 0, w: 4, h: 2 })]);
        expect(findFreeRect(p, 1, 1)).toEqual({ x: 0, y: 2 });
        const full = page([mk({ id: 'a', x: 0, y: 0, w: 4, h: 7 })]);
        expect(findFreeRect(full, 1, 1)).toBeNull();
    });
});

describe('desktopGrid · 单页操作（不可变）', () => {
    it('addItem 显式落点 / 自动找位 / 满页返回 null', () => {
        let p = emptyPage('p');
        const r1 = addItem(p, { kind: 'schedule', x: 0, y: 0 })!;
        expect(r1.item).toMatchObject({ kind: 'schedule', x: 0, y: 0, w: 4, h: 2 });
        expect(p.items).toHaveLength(0); // 原页不变

        const r2 = addItem(r1.page, { kind: 'app', refId: 'chat' })!;
        expect(r2.item).toMatchObject({ kind: 'app', refId: 'chat', x: 0, y: 2, w: 1, h: 1 });

        const filled = page([mk({ id: 'a', x: 0, y: 0, w: 4, h: 7 })]);
        expect(addItem(filled, { kind: 'app', refId: 'x' })).toBeNull();
    });

    it('addItem 显式落点被占用时回退到自动找位', () => {
        const p = page([mk({ id: 'a', x: 0, y: 0, w: 2, h: 2 })]);
        const r = addItem(p, { kind: 'app', refId: 'x', x: 0, y: 0 })!;
        expect(r.item).toMatchObject({ x: 2, y: 0 });
    });

    it('addItemToPageOrInsert 优先用指定页的落点', () => {
        const pages = [emptyPage('current'), emptyPage('next')];
        const placed = addItemToPageOrInsert(pages, 0, { kind: 'app', refId: 'chat', x: 2, y: 1 });
        expect(placed[0].items).toEqual([expect.objectContaining({ refId: 'chat', x: 2, y: 1 })]);
        expect(placed[1]).toBe(pages[1]);
        expect(pages[0].items).toEqual([]);
    });

    it('addItemToPageOrInsert 满页时在两页之间插入普通页', () => {
        const full = page([mk({ w: GRID_COLS, h: GRID_ROWS })]);
        const next = emptyPage('next');
        const placed = addItemToPageOrInsert([full, next], 0, { kind: 'app', refId: 'chat', x: 2, y: 1 });
        expect(placed).toHaveLength(3);
        expect(placed[0]).toBe(full);
        expect(placed[1]).toMatchObject({
            layout: 'standard',
            items: [expect.objectContaining({ refId: 'chat', x: 0, y: 0 })],
        });
        expect(placed[2]).toBe(next);
    });

    it('addItem 统一应用 Registry 默认锁定策略，并尊重显式覆盖', () => {
        expect(addItem(emptyPage('schedule'), { kind: 'schedule' })!.item.locked).toBe(true);
        expect(addItem(emptyPage('schedule-unlocked'), { kind: 'schedule', locked: false })!.item.locked).toBe(false);
        expect(addItem(emptyPage('music'), { kind: 'music' })!.item.locked).toBe(false);
        expect(addItem(emptyPage('app'), { kind: 'app', refId: 'chat' })!.item.locked).toBe(false);
    });

    it('addItem 对显式尺寸执行与 normalize/resize 相同的 Registry contract', () => {
        expect(addItem(emptyPage('app-size'), { kind: 'app', refId: 'chat', w: 3, h: 4 })!.item)
            .toMatchObject({ w: 1, h: 1 });
        expect(addItem(emptyPage('calendar-size'), { kind: 'calendar', w: 1, h: 1 })!.item)
            .toMatchObject({ w: 4, h: 2 });
        expect(addItem(emptyPage('music-size'), { kind: 'music', w: 99, h: 99 })!.item)
            .toMatchObject({ w: 4, h: 4 });
        expect(addItem(emptyPage('fraction-size'), { kind: 'image', w: 1.5, h: 1 })!.item)
            .toMatchObject({ w: 2, h: 1 });
        expect(addItem(emptyPage('nan-size'), { kind: 'image', w: Number.NaN, h: 1 })!.item)
            .toMatchObject({ w: 2, h: 1 });
        expect(addItem(emptyPage('infinite-size'), { kind: 'image', w: 1, h: Number.POSITIVE_INFINITY })!.item)
            .toMatchObject({ w: 1, h: 2 });
        expect(addItem(emptyPage('non-number-size'), { kind: 'image', w: 'wide' as any, h: 1 })!.item)
            .toMatchObject({ w: 2, h: 1 });
    });

    it('moveItem 合法移动 / 撞车不动 / 越界不动', () => {
        const p = page([
            mk({ id: 'a', x: 0, y: 0, w: 1, h: 1 }),
            mk({ id: 'b', x: 1, y: 0, w: 1, h: 1 }),
        ]);
        expect(moveItem(p, 'a', 0, 3).items.find(i => i.id === 'a')).toMatchObject({ x: 0, y: 3 });
        expect(moveItem(p, 'a', 1, 0)).toBe(p); // 撞 b
        expect(moveItem(p, 'a', 4, 0)).toBe(p); // 越界
    });

    it('resizeItem 合法 / 撞车不动', () => {
        const p = page([
            mk({ id: 'a', kind: 'image', x: 0, y: 0, w: 1, h: 1 }),
            mk({ id: 'b', x: 0, y: 2, w: 1, h: 1 }),
        ]);
        expect(resizeItem(p, 'a', 2, 2).items.find(i => i.id === 'a')).toMatchObject({ w: 2, h: 2 });
        expect(resizeItem(p, 'a', Number.NaN, Number.POSITIVE_INFINITY).items.find(i => i.id === 'a'))
            .toMatchObject({ w: 2, h: 2 });
        expect(resizeItem(p, 'a', 1, 4)).toBe(p); // 会盖到 b
    });

    it('resizeItem 在 domain 层执行 Widget Registry 尺寸限制，并强制 App 为 1×1', () => {
        const widgets = page([
            mk({ id: 'calendar', kind: 'calendar', x: 0, y: 0, w: 4, h: 2 }),
            mk({ id: 'quad', kind: 'quad_apps', x: 0, y: 3, w: 2, h: 2 }),
        ]);
        expect(resizeItem(widgets, 'calendar', 1, 1).items.find(i => i.id === 'calendar')).toMatchObject({ w: 4, h: 2 });
        expect(resizeItem(widgets, 'quad', 4, 4).items.find(i => i.id === 'quad')).toMatchObject({ w: 2, h: 2 });

        const appPage = page([mk({ id: 'app', kind: 'app', x: 0, y: 0, w: 3, h: 4 })]);
        expect(resizeItem(appPage, 'app', 2, 2).items[0]).toMatchObject({ w: 1, h: 1 });
    });

    it('removeItem / toggleLock', () => {
        const p = page([mk({ id: 'a' }), mk({ id: 'b' })]);
        expect(removeItem(p, 'a').items.map(i => i.id)).toEqual(['b']);
        expect(toggleLock(p, 'a').items.find(i => i.id === 'a')!.locked).toBe(true);
        expect(toggleLock(toggleLock(p, 'a'), 'a').items.find(i => i.id === 'a')!.locked).toBe(false);
    });
});

describe('desktopGrid · 跨页', () => {
    it('flowItems 溢出到新页，且绕开已有（锁定）条目', () => {
        const start = page([mk({ id: 'lock', kind: 'schedule', x: 0, y: 0, w: 4, h: 2, locked: true })]);
        const specs = Array.from({ length: 30 }, (_, i) => ({ kind: 'app' as const, refId: `app${i}` }));
        const pages = flowItems([start], specs);
        // 第一页锁定块占了 rows 0-1，剩 5 行 = 20 格（GRID_ROWS=7）
        expect(pages[0].items.filter(i => i.kind === 'app')).toHaveLength(20);
        expect(pages.length).toBe(2);
        expect(pages[1].items.filter(i => i.kind === 'app')).toHaveLength(10);
        // 锁定块没被动
        expect(pages[0].items.find(i => i.id === 'lock')).toMatchObject({ x: 0, y: 0, locked: true });
    });

    it('addPage / removePage 至少保留一页，且不能删除唯一 home', () => {
        let pages = [emptyPage('home', 'home')];
        pages = addPage(pages);
        expect(pages).toHaveLength(2);
        expect(removePage(pages, 0)).toBe(pages);
        expect(removePage(pages, 1)).toHaveLength(1);
        expect(removePage([emptyPage('only')], 0)).toHaveLength(1); // 不删最后一页
    });
});

describe('desktopGrid · createDefaultDesktopLayout & normalizeDesktopLayout', () => {
    const valid = new Set(['chat', 'music', 'gallery', 'settings', 'call', 'social']);

    it('normalizeDesktopLayout 保留合法布局，丢弃未知 Widget 与未知 App', () => {
        const dirty: DesktopLayout = {
            version: 1,
            dock: ['chat', 'bank'],
            pages: [
                {
                    id: 'p1',
                    layout: 'standard',
                    items: [
                        { id: 'invalid', kind: 'unknown_widget' as any, x: 0, y: 0, w: 2, h: 2 },
                        { id: 'a1', kind: 'app', refId: 'music', x: 0, y: 0, w: 1, h: 1 },
                        { id: 'a2', kind: 'app', refId: 'bank', x: 1, y: 0, w: 1, h: 1 },
                        { id: 'w1', kind: 'calendar', x: 0, y: 1, w: 4, h: 2 },
                        { id: 'q1', kind: 'quad_apps', x: 0, y: 3, w: 2, h: 2, config: { apps: ['social', 'bank', null, 'settings'] } },
                    ],
                },
            ],
        };
        const normalized = normalizeDesktopLayout(dirty, valid);
        expect(normalized.version).toBe(1);
        expect(normalized.dock).toEqual(['chat']);
        // unknown_widget 与 bogus 均被剔除
        const allItems = normalized.pages.flatMap(page => page.items);
        const allKinds = allItems.map(i => i.kind);
        expect(allKinds).not.toContain('unknown_widget');
        expect(allItems.find(i => i.refId === 'bank')).toBeUndefined();
        expect(allItems.find(i => i.refId === 'music')).toBeDefined();
        expect(allItems.find(i => i.kind === 'calendar')).toBeDefined();
        const quad = allItems.find(i => i.kind === 'quad_apps');
        expect(quad?.config?.apps).toEqual(['social', null, null, 'settings']);
    });

    it('normalizeDesktopLayout 执行 Registry 尺寸、App 1×1 与 singleton 契约', () => {
        const layout: DesktopLayout = {
            version: 1,
            dock: [],
            pages: [
                { id: 'home', layout: 'home', items: [] },
                {
                    id: 'standard-first', layout: 'standard', items: [
                        { id: 'app', kind: 'app', refId: 'chat', x: 0, y: 0, w: 3, h: 4 },
                        { id: 'schedule-first', kind: 'schedule', x: 0, y: 1, w: Number.NaN, h: Number.POSITIVE_INFINITY },
                        { id: 'music', kind: 'music', x: 0, y: 3, w: 1.5, h: 8 },
                    ],
                },
                {
                    id: 'standard-second', layout: 'standard', items: [
                        { id: 'schedule-duplicate', kind: 'schedule', x: 0, y: 0, w: 4, h: 2 },
                    ],
                },
            ],
        };

        const normalized = normalizeDesktopLayout(layout, valid);
        const items = normalized.pages.flatMap(current => current.items);
        expect(items.find(item => item.id === 'app')).toMatchObject({ w: 1, h: 1 });
        expect(items.find(item => item.id === 'schedule-first')).toMatchObject({ w: 4, h: 2 });
        expect(items.find(item => item.id === 'music')).toMatchObject({ w: 2, h: 4 });
        expect(items.filter(item => item.kind === 'schedule').map(item => item.id)).toEqual(['schedule-first']);
    });

    it('normalizeDesktopLayout 让当前页面角色恰好有一个 home，且不依赖页面下标', () => {
        const withoutHome: DesktopLayout = {
            version: 1,
            dock: [],
            pages: [emptyPage('first'), emptyPage('second', 'windmill')],
        };
        const repairedMissing = normalizeDesktopLayout(withoutHome, valid);
        expect(repairedMissing.pages.filter(current => current.layout === 'home')).toHaveLength(1);
        expect(repairedMissing.pages.findIndex(current => current.layout === 'home')).toBe(0);

        const duplicateHome: DesktopLayout = {
            version: 1,
            dock: [],
            pages: [emptyPage('standard'), emptyPage('home-first', 'home'), emptyPage('home-second', 'home')],
        };
        const repairedDuplicate = normalizeDesktopLayout(duplicateHome, valid);
        expect(repairedDuplicate.pages.map(current => current.layout)).toEqual(['standard', 'home', 'standard']);
        expect(rowsForScreen(repairedDuplicate.pages[0])).toBe(APP_PAGE_ROWS);
        expect(rowsForScreen(repairedDuplicate.pages[1])).toBe(HOME_PAGE_ROWS);
        expect(rowsForScreen(repairedDuplicate.pages[2])).toBe(APP_PAGE_ROWS);
    });

    it('resolveDesktopLayout 在 normalization 抛错时回到合法 current default layout', () => {
        let reported = false;
        const malformed = { version: 1, dock: [], pages: [null] } as unknown as DesktopLayout;
        const resolved = resolveDesktopLayout(malformed, valid, [], () => { reported = true; });

        expect(reported).toBe(true);
        expect(resolved.pages.filter(current => current.layout === 'home')).toHaveLength(1);
    });

    it('createDefaultDesktopLayout 正确生成负一屏、主屏、风车页和后续页', () => {
        const appList = Array.from({ length: 30 }, (_, i) => `app_${i}`);
        const validApps = new Set(appList);
        const defaultDock = ['app_0', 'app_1', 'app_2', 'app_3'];
        const layout = createDefaultDesktopLayout(validApps, defaultDock);

        expect(layout.version).toBe(1);
        expect(layout.dock).toEqual(defaultDock);

        // Page 0: standard (负一屏)
        expect(layout.pages[0].layout).toBe('standard');
        expect(layout.pages[0].items).toHaveLength(0);

        // Page 1: home (主屏，最多 8 个 app)
        expect(layout.pages[1].layout).toBe('home');
        expect(layout.pages[1].items.filter(i => i.kind === 'app').length).toBeLessThanOrEqual(8);
        for (const it of layout.pages[1].items) {
            expect(it.y + it.h).toBeLessThanOrEqual(HOME_PAGE_ROWS);
        }

        // Page 2: windmill (风车页)
        const p2 = layout.pages[2];
        expect(p2.layout).toBe('windmill');
        expect(p2.items.find(i => i.kind === 'schedule')).toMatchObject({ x: 0, y: 0, w: 4, h: 2, locked: true });
        expect(p2.items.find(i => i.kind === 'music')).toMatchObject({ x: 0, y: 2, w: 2, h: 2 });
        expect(p2.items.find(i => i.kind === 'quad_apps' && i.x === 2 && i.y === 2)).toBeDefined();
        expect(p2.items.find(i => i.kind === 'quad_apps' && i.x === 0 && i.y === 4)).toBeDefined();
        expect(p2.items.find(i => i.kind === 'image')).toMatchObject({ x: 2, y: 4, w: 2, h: 2 });

        // 所有 30 个 app 均被放置（Dock + 网格互斥且全覆盖）
        const placed = collectPlacedAppIds(layout.pages);
        for (const dockApp of layout.dock) {
            expect(placed.has(dockApp)).toBe(false);
        }
        for (const app of appList) {
            const inDock = layout.dock.includes(app);
            const inGrid = placed.has(app);
            expect(inDock !== inGrid).toBe(true);
        }

        // 条目互不重叠且在网格内
        for (const p of layout.pages) {
            for (let i = 0; i < p.items.length; i++) {
                expect(withinGrid(p.items[i], GRID_COLS, GRID_ROWS)).toBe(true);
                for (let j = i + 1; j < p.items.length; j++) {
                    expect(rectsOverlap(p.items[i], p.items[j])).toBe(false);
                }
            }
        }
    });

    it('rowsForScreen 只尊重 layout，不从下标推断角色', () => {
        expect(rowsForScreen({ id: 'standard', items: [], layout: 'standard' })).toBe(APP_PAGE_ROWS);
        expect(rowsForScreen({ id: 'home', items: [], layout: 'home' })).toBe(HOME_PAGE_ROWS);
        expect(rowsForScreen({ id: 'windmill', items: [], layout: 'windmill' })).toBe(WINDMILL_PAGE_ROWS);

        const withWindmill = addPage([], 'windmill');
        expect(withWindmill[0].layout).toBe('windmill');
        const withStandard = addPage([], 'standard');
        expect(withStandard[0].layout).toBe('standard');
    });

    it('四宫格包含 null 项时 collectPlacedAppIds 正常过滤', () => {
        const pageWithQuadNull: DesktopPage = {
            id: 'p_null',
            layout: 'standard',
            items: [
                { id: 'q1', kind: 'quad_apps', x: 0, y: 0, w: 2, h: 2, config: { apps: ['app_1', null, 'app_2', undefined] } },
            ],
        };
        const placedWithNull = collectPlacedAppIds([pageWithQuadNull]);
        expect(placedWithNull).toEqual(new Set(['app_1', 'app_2']));
    });
});

describe('desktopGrid · enforceHomeRowCap', () => {
    it('主屏行数变矮后，越界条目搬到后面的页而不是被裁掉', () => {
        const home: DesktopPage = {
            id: 'home', layout: 'home', items: [
                mk({ id: 'ok', x: 0, y: 0, w: 1, h: 1 }),
                mk({ id: 'over', x: 0, y: HOME_PAGE_ROWS, w: 1, h: 1 }), // 越界：y 已经在矮行数之外
            ],
        };
        const pages: DesktopPage[] = [emptyPage('m1'), home, emptyPage('p2')];
        const out = enforceHomeRowCap(pages);
        expect(out[1].items.map(i => i.id)).toEqual(['ok']);
        // 搬走的条目会重新分配 id（落点变了），按 kind 数量核对没有丢
        expect(out[2].items.filter(i => i.kind === 'app')).toHaveLength(1);
    });

    it('没有越界条目时原样返回', () => {
        const home: DesktopPage = { id: 'home', layout: 'home', items: [mk({ id: 'ok', x: 0, y: 0, w: 1, h: 1 })] };
        const pages: DesktopPage[] = [emptyPage('m1'), home];
        expect(enforceHomeRowCap(pages)).toBe(pages);
    });
});

describe('desktopGrid · repairOverlaps', () => {
    it('没有重叠 / 越界时原样返回（引用不变）', () => {
        const pages: DesktopPage[] = [
            emptyPage('m1'),
            page([mk({ id: 'a', x: 0, y: 0, w: 1, h: 1 })]),
        ];
        expect(repairOverlaps(pages)).toBe(pages);
    });

    it('修复同页内两个条目重叠：后面的条目被挪到空位', () => {
        const dirty: DesktopPage[] = [
            emptyPage('m1'),
            page([
                mk({ id: 'a', x: 0, y: 0, w: 2, h: 2 }),
                mk({ id: 'b', x: 1, y: 1, w: 2, h: 2 }), // 与 a 重叠
            ]),
        ];
        const out = repairOverlaps(dirty);
        const [a, b] = [out[1].items.find(i => i.id === 'a')!, out[1].items.find(i => i.id === 'b')!];
        expect(a).toMatchObject({ x: 0, y: 0 }); // 先来的不动
        expect(rectsOverlap(a, b)).toBe(false); // 后来的挪开了
        expect(withinGrid(b, GRID_COLS, rowsForScreen(out[1]))).toBe(true);
    });

    it('修复越界条目：搬回网格内且不与其他条目重叠', () => {
        const dirty: DesktopPage[] = [
            page([
                mk({ id: 'a', x: 0, y: 0, w: 1, h: 1 }),
                mk({ id: 'over', x: 2, y: GRID_ROWS - 1, w: 2, h: 2 }), // 底部越界
            ]),
            emptyPage('m2'),
        ];
        const out = repairOverlaps(dirty);
        const fixed = out[0].items.find(i => i.id === 'over')!;
        expect(withinGrid(fixed, GRID_COLS, GRID_ROWS)).toBe(true);
        expect(rectsOverlap(fixed, out[0].items.find(i => i.id === 'a')!)).toBe(false);
    });

    it('本页放不下时溢出到后续页（沿用 flowItems 逻辑）', () => {
        // 把一整页塞满，再加一个和已有条目重叠、又放不进本页剩余空间的条目
        const fullItems = Array.from({ length: GRID_COLS * GRID_ROWS / 1 }, (_, i) =>
            mk({ id: `f${i}`, x: i % GRID_COLS, y: Math.floor(i / GRID_COLS), w: 1, h: 1 }));
        const overflow = mk({ id: 'overflow', x: 0, y: 0, w: 1, h: 1, kind: 'app', refId: 'extra' });
        // 让 overflow 与已有条目重叠，逼它去找新位置；页面已满，只能流到下一页
        const dirty: DesktopPage[] = [
            page([...fullItems, overflow]), // 非主屏（数组下标 0），用满 GRID_ROWS 行
            emptyPage('m2'),
        ];
        const out = repairOverlaps(dirty);
        // overflow 条目被挪去了别的页（本页放不下），且没有丢失、没有和任何条目重叠
        const placedOverflow = out.find(p => p.items.some(i => i.refId === 'extra'));
        expect(placedOverflow).toBeDefined();
        const ov = placedOverflow!.items.find(i => i.refId === 'extra')!;
        expect(placedOverflow!.items.every(i => i === ov || !rectsOverlap(i, ov))).toBe(true);
        // 满页那一页仍然只有原来的条目，overflow 没有原地重叠摆放
        expect(out[0].items.filter(i => i.refId === 'extra')).toHaveLength(0);
    });
});

describe('desktopGrid · createDefaultDesktopLayout 空 app 兜底', () => {
    it('validAppIds 为空时不会崩溃，生成默认结构', () => {
        const layout = createDefaultDesktopLayout(new Set(), []);
        expect(layout.version).toBe(1);
        expect(layout.pages.length).toBeGreaterThanOrEqual(1);
    });
});

describe('desktopGrid · tryDisplace 挤开机制', () => {
    it('目标区域为空，无需挤开任何条目', () => {
        const p = page([mk({ id: 'a', x: 0, y: 0, w: 1, h: 1 })]);
        const res = tryDisplace(p, { x: 1, y: 0, w: 1, h: 1 });
        expect(res).not.toBeNull();
        expect(res!.ok).toBe(true);
        expect(res!.displacedItems.size).toBe(0);
    });

    it('单个 1×1 App 被挤开到最近的相邻空格', () => {
        const p = page([
            mk({ id: 'a', x: 1, y: 0, w: 1, h: 1 }), // 目标位置已被 a 占据
        ]);
        // 尝试把新条目放在 (1, 0)
        const res = tryDisplace(p, { x: 1, y: 0, w: 1, h: 1 });
        expect(res).not.toBeNull();
        expect(res!.ok).toBe(true);
        expect(res!.displacedItems.has('a')).toBe(true);
        const newPos = res!.displacedItems.get('a')!;
        // 新位置必须合法、在网格内，且不与 (1, 0) 重叠
        expect(withinGrid({ ...newPos, w: 1, h: 1 })).toBe(true);
        expect(rectsOverlap({ ...newPos, w: 1, h: 1 }, { x: 1, y: 0, w: 1, h: 1 })).toBe(false);
    });

    it('同页拖拽时，被撞条目可以互换（swap）到拖拽项腾出的原位置', () => {
        const p = page([
            mk({ id: 'dragging', x: 0, y: 0, w: 1, h: 1 }),
            mk({ id: 'target', x: 1, y: 0, w: 1, h: 1 }),
            mk({ id: 'c', x: 2, y: 0, w: 1, h: 1 }),
        ]);
        // dragging 从 (0,0) 移到 (1,0)，ignoreId = 'dragging'
        const res = tryDisplace(p, { x: 1, y: 0, w: 1, h: 1 }, 'dragging');
        expect(res).not.toBeNull();
        expect(res!.ok).toBe(true);
        // target 离 (0,0) 最近（距离 1），应该正好交换到 (0,0)！
        expect(res!.displacedItems.get('target')).toEqual({ x: 0, y: 0 });
    });

    it('非相邻同页拖拽重叠时，被撞条目直接与拖拽项进行互换（swap）', () => {
        const p = page([
            mk({ id: 'dragging', x: 0, y: 3, w: 1, h: 1 }),
            mk({ id: 'target', x: 1, y: 0, w: 1, h: 1 }),
            mk({ id: 'emptyNeighbor', x: 2, y: 0, w: 1, h: 1 }),
        ]);
        // dragging 从远处的 (0,3) 拖拽覆盖到 (1,0)
        const res = tryDisplace(p, { x: 1, y: 0, w: 1, h: 1 }, 'dragging');
        expect(res).not.toBeNull();
        expect(res!.ok).toBe(true);
        // target 应该与 dragging 进行 1:1 互换，挪到 (0,3)
        expect(res!.displacedItems.get('target')).toEqual({ x: 0, y: 3 });
    });

    it('撞到锁定条目（locked: true）时无法挤开，返回 null', () => {
        const p = page([
            mk({ id: 'lockedSchedule', x: 0, y: 0, w: 4, h: 2, locked: true }),
        ]);
        const res = tryDisplace(p, { x: 1, y: 1, w: 1, h: 1 });
        expect(res).toBeNull();
    });

    it('页面已满无空位时无法挤开，返回 null', () => {
        // 填满所有格子
        const items = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) =>
            mk({ id: `item-${i}`, x: i % GRID_COLS, y: Math.floor(i / GRID_COLS), w: 1, h: 1 })
        );
        const p = page(items);
        const res = tryDisplace(p, { x: 0, y: 0, w: 1, h: 1 });
        expect(res).toBeNull();
    });

    it('目标区域越界返回 null', () => {
        const p = page([]);
        expect(tryDisplace(p, { x: 3, y: 0, w: 2, h: 1 })).toBeNull();
        expect(tryDisplace(p, { x: -1, y: 0, w: 1, h: 1 })).toBeNull();
    });

    it('applyDisplacements 正确更新被挤开条目的坐标', () => {
        const p = page([
            mk({ id: 'a', x: 1, y: 0, w: 1, h: 1 }),
            mk({ id: 'b', x: 2, y: 0, w: 1, h: 1 }),
        ]);
        const disp = new Map([['a', { x: 0, y: 1 }]]);
        const next = applyDisplacements(p, disp);
        expect(next.items.find(i => i.id === 'a')).toMatchObject({ x: 0, y: 1 });
        expect(next.items.find(i => i.id === 'b')).toMatchObject({ x: 2, y: 0 });
    });
});

describe('desktopGrid · 统一 Dock 布局', () => {
    const validApps = new Set(['chat', 'social', 'settings', 'music', 'gallery']);
    const baseLayout = (): DesktopLayout => ({
        version: 1,
        dock: ['chat'],
        pages: [{
            id: 'home', layout: 'home', items: [
                mk({ id: 'social-app', refId: 'social', x: 0, y: 0 }),
                mk({ id: 'quad', kind: 'quad_apps', x: 2, y: 0, w: 2, h: 2, config: { apps: ['settings', 'music', null, null] } }),
            ],
        }],
    });

    it('normalizeDesktopLayout 把 Dock 与网格保持互斥', () => {
        const layout: DesktopLayout = {
            version: 1,
            dock: ['chat'],
            pages: [{
                id: 'home', layout: 'home', items: [
                    mk({ id: 'chat-app', refId: 'chat', x: 0, y: 0 }),
                    mk({ id: 'social-app', refId: 'social', x: 1, y: 0 }),
                ],
            }],
        };
        const normalized = normalizeDesktopLayout(layout, validApps);
        expect(normalized.version).toBe(1);
        expect(normalized.dock).toEqual(['chat']);
        expect(collectPlacedAppIds(normalized.pages).has('chat')).toBe(false);
        expect(collectPlacedAppIds(normalized.pages).has('social')).toBe(true);
    });

    it('移入 Dock 会从普通格与四宫格同时移除，满位不挤掉旧 App', () => {
        const moved = moveAppToDock(baseLayout(), 'settings');
        expect(moved.dock).toEqual(['chat', 'settings']);
        expect(moved.pages[0].items.find(item => item.id === 'quad')?.config?.apps).toEqual([null, 'music', null, null]);

        const full: DesktopLayout = { ...moved, dock: ['chat', 'settings', 'social', 'music'] };
        expect(moveAppToDock(full, 'gallery')).toBe(full);
    });

    it('移出 Dock 会在目标页找到空位；无空间时不丢失 Dock 项', () => {
        const moved = moveAppFromDock(baseLayout(), 'chat', 0);
        expect(moved.dock).toEqual([]);
        expect(collectPlacedAppIds(moved.pages).has('chat')).toBe(true);

        const fullPage: DesktopLayout = {
            version: 1,
            dock: ['chat'],
            pages: [page([mk({ id: 'full', x: 0, y: 0, w: 4, h: 7 })])],
        };
        expect(moveAppFromDock(fullPage, 'chat', 0)).toBe(fullPage);
    });

    it('移出 Dock 可以严格放置到指定 cell', () => {
        const base = baseLayout();
        const layout: DesktopLayout = {
            ...base,
            pages: [{ ...base.pages[0], layout: 'standard' }],
        };
        const moved = moveAppFromDock(layout, 'chat', 0, { x: 2, y: 3 });
        expect(moved.dock).toEqual([]);
        expect(moved.pages[0].items.find(item => item.refId === 'chat')).toMatchObject({
            kind: 'app', x: 2, y: 3, w: 1, h: 1,
        });
    });

    it('指定 cell 被占用时保持原布局，不丢失 Dock App', () => {
        const layout = baseLayout();
        expect(moveAppFromDock(layout, 'chat', 0, { x: 0, y: 0 })).toBe(layout);
        expect(layout.dock).toEqual(['chat']);
    });

    it('指定非法 pageIndex 时保持原布局', () => {
        const layout = baseLayout();
        expect(moveAppFromDock(layout, 'chat', 99, { x: 2, y: 3 })).toBe(layout);
    });

    it('App 不在 Dock 时保持原布局', () => {
        const layout = baseLayout();
        expect(moveAppFromDock(layout, 'gallery', 0, { x: 2, y: 3 })).toBe(layout);
    });

    it('Dock 排序只接受已存在的 App，并保留未指定项', () => {
        const layout: DesktopLayout = { ...baseLayout(), dock: ['chat', 'social', 'settings'] };
        expect(reorderDock(layout, ['settings', 'unknown'] as string[]).dock).toEqual(['settings', 'chat', 'social']);
    });
});

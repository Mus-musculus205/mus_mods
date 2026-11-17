import { describe, expect, it } from 'vitest';
import type { DesktopLayout, DesktopPage, PlacedItem } from '../registry/widgets/layout';
import {
  FOLDER_CAPACITY, FOLDER_KIND, canDropAppOnItem, dropAppOnItem, readFolderConfig, removeAppFromFolder, renameFolder,
} from './desktopFolders';
import {
  collectPlacedAppIds, dissolveFolderOntoPages, moveAppToDock, normalizeDesktopLayout, removeItem,
} from './desktopGrid';

const app = (id: string, x: number, y: number): PlacedItem => ({ id: `it-${id}`, kind: 'app', refId: id, x, y, w: 1, h: 1 });
const folder = (id: string, apps: string[], x = 0, y = 0): PlacedItem => ({
  id, kind: FOLDER_KIND, x, y, w: 1, h: 1, config: { name: '常用', apps },
});
const page = (items: PlacedItem[], layout: DesktopPage['layout'] = 'standard'): DesktopPage => ({ id: `pg-${items.length}`, items, layout });

describe('dropAppOnItem', () => {
  it('turns the target app into a folder in the same cell holding both apps', () => {
    const src = page([app('a', 1, 2), app('b', 3, 0)]);
    const withoutDragged = removeItem(src, 'it-b');
    const next = dropAppOnItem(withoutDragged, 'it-a', 'b');
    expect(next.items).toHaveLength(1);
    const created = next.items[0];
    expect(created.kind).toBe(FOLDER_KIND);
    expect({ x: created.x, y: created.y, w: created.w, h: created.h }).toEqual({ x: 1, y: 2, w: 1, h: 1 });
    expect(readFolderConfig(created).apps).toEqual(['a', 'b']);
  });

  it('appends to an existing folder', () => {
    const next = dropAppOnItem(page([folder('f', ['a', 'b'])]), 'f', 'c');
    expect(readFolderConfig(next.items[0]).apps).toEqual(['a', 'b', 'c']);
  });

  it('refuses a full folder, a folder already holding the app, and an app onto itself', () => {
    const full = folder('f', Array.from({ length: FOLDER_CAPACITY }, (_, i) => `x${i}`));
    expect(canDropAppOnItem(full, 'new')).toBe(false);
    expect(canDropAppOnItem(folder('g', ['a', 'b']), 'a')).toBe(false);
    expect(canDropAppOnItem(app('a', 0, 0), 'a')).toBe(false);
    expect(() => dropAppOnItem(page([full]), 'f', 'new')).toThrow();
  });
});

describe('removeAppFromFolder', () => {
  it('keeps the folder while two or more apps remain', () => {
    const next = removeAppFromFolder(page([folder('f', ['a', 'b', 'c'])]), 'f', 'b');
    expect(readFolderConfig(next.items[0]).apps).toEqual(['a', 'c']);
  });

  it('dissolves into the last app in the folder cell', () => {
    const next = removeAppFromFolder(page([folder('f', ['a', 'b'], 2, 3)]), 'f', 'a');
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ kind: 'app', refId: 'b', x: 2, y: 3, w: 1, h: 1 });
  });
});

describe('renameFolder', () => {
  it('falls back to the default name when blank', () => {
    const next = renameFolder(page([folder('f', ['a', 'b'])]), 'f', '   ');
    expect(readFolderConfig(next.items[0]).name).toBe('文件夹');
  });
});

describe('folders in the layout', () => {
  const layout = (items: PlacedItem[]): DesktopLayout => ({
    version: 1,
    pages: [page([], 'home'), page(items)],
    dock: [],
  });

  it('counts folder apps as placed', () => {
    expect([...collectPlacedAppIds([page([folder('f', ['a', 'b'])])])].sort()).toEqual(['a', 'b']);
  });

  it('drops unknown and duplicate apps and dissolves folders left with one app', () => {
    const normalized = normalizeDesktopLayout(layout([folder('f', ['a', 'gone', 'a']), folder('g', ['b', 'c'], 1, 0)]), new Set(['a', 'b', 'c']));
    const items = normalized.pages[1].items;
    expect(items.find(it => it.kind === 'app')).toMatchObject({ refId: 'a', x: 0, y: 0 });
    expect(readFolderConfig(items.find(it => it.id === 'g')!).apps).toEqual(['b', 'c']);
  });

  it('moving a folder app to the dock takes it out of the folder', () => {
    const next = moveAppToDock(layout([folder('f', ['a', 'b', 'c'])]), 'b');
    expect(next.dock).toEqual(['b']);
    expect(readFolderConfig(next.pages[1].items[0]).apps).toEqual(['a', 'c']);
  });

  it('deleting a folder puts its apps back on the desktop, spilling onto a new page when full', () => {
    const filler = Array.from({ length: 27 }, (_, i) => app(`fill${i}`, (i + 1) % 4, Math.floor((i + 1) / 4)));
    const pages = [page([folder('f', ['a', 'b', 'c']), ...filler])];
    const next = dissolveFolderOntoPages(pages, 0, 'f');
    expect(next).toHaveLength(2);
    expect(next[0].items.filter(it => it.refId === 'a')).toHaveLength(1);
    expect(next[1].items.map(it => it.refId).sort()).toEqual(['b', 'c']);
    expect(next.flatMap(pg => pg.items).some(it => it.kind === FOLDER_KIND)).toBe(false);
  });
});

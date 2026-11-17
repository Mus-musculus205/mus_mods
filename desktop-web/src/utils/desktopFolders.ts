/**
 * 桌面文件夹（古早 iOS 式）—— 纯逻辑层，不碰 UI。
 *
 * 文件夹是网格上一个 1×1 的条目：kind 'app_folder'，config = { name, apps }。
 * - 把一个 App 拖到另一个 App 上 → 两个合成一个文件夹，占目标 App 原来的格子；
 * - 拖到文件夹上 → 放进去；
 * - 从文件夹里移出后只剩一个 App → 文件夹解散，剩下的 App 回到文件夹原来的格子；没有 App 了 → 移除。
 * 所有操作返回新对象，不改入参。
 */
import type { DesktopPage, PlacedItem } from '../registry/widgets/layout';
import { makeItemId } from './desktopIds';

export const FOLDER_KIND = 'app_folder' as const;
export const FOLDER_CAPACITY = 16;
export const DEFAULT_FOLDER_NAME = '文件夹';

export interface FolderConfig {
    name: string;
    apps: string[];
}

export const isFolderItem = (item: PlacedItem): boolean => item.kind === FOLDER_KIND;

/** 读出文件夹配置；名字为空时用默认名，apps 只保留字符串。 */
export const readFolderConfig = (item: PlacedItem): FolderConfig => {
    const rawApps: unknown[] = Array.isArray(item.config?.apps) ? item.config.apps : [];
    const name = typeof item.config?.name === 'string' && item.config.name.trim()
        ? item.config.name
        : DEFAULT_FOLDER_NAME;
    return { name, apps: rawApps.filter((id): id is string => typeof id === 'string') };
};

/** 能不能把 dragged 合进 target：两个不同的 App 合成新文件夹，或 App 放进还有空位且没有它的文件夹。 */
export const canDropAppOnItem = (target: PlacedItem, draggedAppId: string): boolean => {
    if (target.kind === 'app') return !!target.refId && target.refId !== draggedAppId;
    if (!isFolderItem(target)) return false;
    const { apps } = readFolderConfig(target);
    return apps.length < FOLDER_CAPACITY && !apps.includes(draggedAppId);
};

/**
 * 把 App 放到目标条目上：目标是 App 就原地换成文件夹，目标是文件夹就追加。
 * 被拖的那个条目要由调用方先从来源页移除（来源页可能就是这一页）。
 */
export const dropAppOnItem = (page: DesktopPage, targetId: string, draggedAppId: string): DesktopPage => {
    const target = page.items.find(item => item.id === targetId);
    if (!target) throw new Error(`[desktopFolders] 目标条目不存在：${targetId}`);
    if (!canDropAppOnItem(target, draggedAppId)) {
        throw new Error(`[desktopFolders] ${draggedAppId} 不能放到 ${target.kind} 条目 ${targetId} 上`);
    }
    const next: PlacedItem = target.kind === 'app'
        ? {
            id: makeItemId(FOLDER_KIND),
            kind: FOLDER_KIND,
            x: target.x, y: target.y, w: 1, h: 1,
            locked: false,
            config: { name: DEFAULT_FOLDER_NAME, apps: [target.refId!, draggedAppId] },
        }
        : { ...target, config: { ...target.config, apps: [...readFolderConfig(target).apps, draggedAppId] } };
    return { ...page, items: page.items.map(item => (item.id === targetId ? next : item)) };
};

/** 文件夹里的 App 少于两个时就地解散：剩一个变回普通 App，一个都没有就移除。 */
const settleFolder = (folder: PlacedItem, apps: string[]): PlacedItem | null => {
    if (apps.length >= 2) return { ...folder, config: { ...folder.config, apps } };
    if (apps.length === 1) {
        return { id: makeItemId('app'), kind: 'app', refId: apps[0], x: folder.x, y: folder.y, w: 1, h: 1, locked: false };
    }
    return null;
};

/** 把 App 从文件夹里拿出来（不负责把它放到桌面别处）。 */
export const removeAppFromFolder = (page: DesktopPage, folderId: string, appId: string): DesktopPage => {
    const folder = page.items.find(item => item.id === folderId);
    if (!folder || !isFolderItem(folder)) throw new Error(`[desktopFolders] 文件夹不存在：${folderId}`);
    const apps = readFolderConfig(folder).apps.filter(id => id !== appId);
    const settled = settleFolder(folder, apps);
    return {
        ...page,
        items: settled
            ? page.items.map(item => (item.id === folderId ? settled : item))
            : page.items.filter(item => item.id !== folderId),
    };
};

export const renameFolder = (page: DesktopPage, folderId: string, name: string): DesktopPage => ({
    ...page,
    items: page.items.map(item => (item.id === folderId
        ? { ...item, config: { ...item.config, name: name.trim() || DEFAULT_FOLDER_NAME } }
        : item)),
});

export const reorderFolderApps = (page: DesktopPage, folderId: string, apps: readonly string[]): DesktopPage => ({
    ...page,
    items: page.items.map(item => (item.id === folderId ? { ...item, config: { ...item.config, apps: [...apps] } } : item)),
});

/**
 * 布局规范化用：只留合法、去重、未超容量的 App；keep 返回 false 的 App 也去掉（如已进 Dock）。
 * 去掉后不足两个就解散。
 */
export const normalizeFolderItem = (
    folder: PlacedItem,
    keep: (appId: string) => boolean,
): PlacedItem | null => {
    const seen = new Set<string>();
    const apps: string[] = [];
    for (const id of readFolderConfig(folder).apps) {
        if (seen.has(id) || !keep(id) || apps.length >= FOLDER_CAPACITY) continue;
        seen.add(id);
        apps.push(id);
    }
    return settleFolder({ ...folder, w: 1, h: 1, config: { ...folder.config, name: readFolderConfig(folder).name } }, apps);
};

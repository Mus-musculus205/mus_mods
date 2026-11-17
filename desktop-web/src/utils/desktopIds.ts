/** 桌面条目与页面的 id 生成（desktopGrid 与 desktopFolders 共用）。 */
let _seq = 0;
export const makeItemId = (kind: string): string =>
    `gi-${kind}-${Date.now().toString(36)}-${(_seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
export const makePageId = (): string =>
    `pg-${Date.now().toString(36)}-${(_seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

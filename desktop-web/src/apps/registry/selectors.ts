import { AppID } from './types';
import type { AppRegistry } from './defineAppRegistry';
import type { AppDefinition, DesktopAppDefinition } from './types';

/**
 * App Registry selectors — 纯查询函数集合
 *
 * 所有函数：
 * - 不保存自己的 App 数据
 * - 不复制 Registry 内容
 * - 不维护第二份 AppID 列表
 * - 结果每次都从 Registry 计算
 */

// ─────────────────────────────────────────────────────────────
// UI & Analytics name lookup
// ─────────────────────────────────────────────────────────────

/**
 * 给定 AppID，返回用于 UI / analytics 的显示名称。
 * 覆盖所有 exposure 类型（desktop + hidden + dev-only + shell）。
 */
export function getAppDisplayName(
    registry: AppRegistry,
    id: AppID,
): string | undefined {
    return registry.getDefinition(id)?.displayName;
}

// ─────────────────────────────────────────────────────────────
// Dock
// ─────────────────────────────────────────────────────────────

/**
 * 返回默认 Dock App 的 AppDefinition 列表，按 defaultDockSlot 升序排列。
 *
 * 等价于：
 *   registry.entries
 *     .filter(e => e.definition.defaultDockSlot !== undefined)
 *     .sort((a, b) => a.definition.defaultDockSlot! - b.definition.defaultDockSlot!)
 *     .map(e => e.definition)
 */
export function getDefaultDockApps(
    registry: AppRegistry,
): ReadonlyArray<AppDefinition> {
    return registry.entries
        .filter(e => e.definition.defaultDockSlot !== undefined)
        .sort((a, b) => a.definition.defaultDockSlot! - b.definition.defaultDockSlot!)
        .map(e => e.definition);
}

/**
 * 返回默认 Dock 的 AppID 列表，按 defaultDockSlot 升序排列。
 * 与 getDefaultDockApps 同义，供只需要 AppID[] 的调用方使用。
 */
export function getDefaultDockAppIds(
    registry: AppRegistry,
): ReadonlyArray<AppID> {
    return getDefaultDockApps(registry).map(d => d.id);
}

// ─────────────────────────────────────────────────────────────
// Desktop apps
// ─────────────────────────────────────────────────────────────

/**
 * 返回所有 desktop 或 dev-only exposure 的 App 的 DesktopAppDefinition 列表。
 *
 * 注意：CharCreatorDev（dev-only）是否显示由 Launcher 根据 devDebugVisible 决定，
 * 不由 selector 过滤。selector 只区分 exposure，不处理运行时开关。
 */
export function getInstalledAppDefinitions(
    registry: AppRegistry,
): ReadonlyArray<DesktopAppDefinition> {
    return registry.entries
        .filter(e => e.definition.exposure === 'desktop' || e.definition.exposure === 'dev-only')
        .map(e => e.definition as DesktopAppDefinition);
}

/**
 * 根据 AppID 获取可置于桌面的 App 定义（desktop 或 dev-only）。
 * 若该 App 为 shell 或 hidden 或未注册，返回 undefined。
 */
export function getDesktopAppDefinition(
    registry: AppRegistry,
    id: AppID,
): DesktopAppDefinition | undefined {
    const def = registry.getDefinition(id);
    if (def && (def.exposure === 'desktop' || def.exposure === 'dev-only')) {
        return def as DesktopAppDefinition;
    }
    return undefined;
}

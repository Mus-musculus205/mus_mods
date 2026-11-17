import type { WidgetKind } from './layout';
import type { WidgetDefinition } from './types';
import { WIDGET_DEFINITION_MAP, WIDGET_DEFINITIONS } from './manifest';

/** 检查某个字符串是否为合法当前 WidgetKind（基于 WIDGET_DEFINITION_MAP 正向校验，禁止手写名单）。 */
export function isWidgetKind(value: string): value is WidgetKind {
    return Object.prototype.hasOwnProperty.call(WIDGET_DEFINITION_MAP, value);
}

/** 根据 kind 查询对应 WidgetDefinition。非 widget 返回 undefined。 */
export function getWidgetDefinition(kind: WidgetKind): WidgetDefinition | undefined {
    return (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
}

/** 查询小组件的默认尺寸（格数）。非 widget 兜底为 1×1。 */
export function getWidgetDefaultSize(kind: WidgetKind): { w: number; h: number } {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    return def ? { w: def.size.default.w, h: def.size.default.h } : { w: 1, h: 1 };
}

/** 查询小组件的尺寸限制（min / max）。非 widget 返回 undefined。 */
export function getWidgetSizeLimits(kind: WidgetKind): {
    min: { w: number; h: number };
    max: { w: number; h: number };
} | undefined {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    if (!def) return undefined;
    return {
        min: { w: def.size.min.w, h: def.size.min.h },
        max: { w: def.size.max.w, h: def.size.max.h },
    };
}

/**
 * 条目新建时是否默认锁定。
 * 唯一策略 Authority（取代过去的 DEFAULT_LOCKED_KINDS 与局部硬编码）。
 */
export function isWidgetDefaultLocked(kind: string): boolean {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    return !!def?.defaultLocked;
}

/** 该小组件在整个桌面布局中是否只允许存在一个实例。 */
export function isWidgetSingleton(kind: string): boolean {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    return !!def?.singleton;
}

/** 该条目是否支持拉伸改大小（max > min）。App 与不可伸缩小组件返回 false。 */
export function canResizeWidget(kind: string): boolean {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    if (!def) return false;
    return def.size.max.w > def.size.min.w || def.size.max.h > def.size.min.h;
}

/** 该小组件是否支持背景透明度调节（通用 capability）。 */
export function supportsWidgetOpacity(kind: string): boolean {
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    return !!def?.capabilities?.opacity;
}

/** 网格条目是否按 App 图标的方式摆放：App 本身，以及注册了 iconCell 的小组件（如文件夹）。 */
export function rendersAsIconCell(kind: string): boolean {
    if (kind === 'app') return true;
    const def = (WIDGET_DEFINITION_MAP as Record<string, WidgetDefinition>)[kind];
    return !!def?.iconCell;
}

/** 获取小组件库（Gallery）展示列表：除标了 galleryHidden 的（如文件夹）外都在。 */
export function getGalleryWidgetDefinitions(): ReadonlyArray<WidgetDefinition> {
    return WIDGET_DEFINITIONS.filter(def => !def.galleryHidden);
}

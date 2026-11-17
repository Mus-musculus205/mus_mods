import type { WidgetKind } from './layout';
import type { WidgetDefinition, WidgetRegistryValidationResult } from './types';

/**
 * 所有当前合法自由网格小组件的元数据定义映射。
 *
 * 契约：
 * - WidgetKind 是唯一的 identity authority（由 layout.ts 声明）。
 * - WIDGET_DEFINITION_MAP 使用 satisfies Record<WidgetKind, WidgetDefinition>，
 *   在编译期强制要求覆盖全部 WidgetKind，漏定义或多定义均由 TypeScript 编译器报错。
 * - 绝不允许维护第二份手写字符串数组。
 */
export const WIDGET_DEFINITION_MAP = {
    schedule: {
        kind: 'schedule',
        label: '日程',
        description: '角色此刻在做什么 · 拉大看接下来几段',
        size: {
            default: { w: 4, h: 2 },
            min: { w: 3, h: 2 },
            max: { w: 4, h: 4 },
        },
        singleton: true,
        defaultLocked: true,
        capabilities: { opacity: true },
    },
    music: {
        kind: 'music',
        label: '黑胶音乐播放器',
        description: '正在播放的歌 + 旋转黑胶，可定制贴纸',
        size: {
            default: { w: 2, h: 2 },
            min: { w: 2, h: 2 },
            max: { w: 4, h: 4 },
        },
        capabilities: { opacity: true },
    },
    image: {
        kind: 'image',
        label: '相框',
        description: '在桌面上摆一张喜欢的图，点一下换（宽度也能设成 1 格的窄条幅）',
        size: {
            default: { w: 2, h: 2 },
            min: { w: 1, h: 1 },
            max: { w: 4, h: 4 },
        },
    },
    calendar: {
        kind: 'calendar',
        label: '整月日历',
        description: '整月日期与日程标记，轻触直达日程',
        size: {
            default: { w: 4, h: 3 },
            min: { w: 4, h: 2 },
            max: { w: 4, h: 4 },
        },
        capabilities: { opacity: true },
    },
    anniversary: {
        kind: 'anniversary',
        label: '纪念日与倒计时',
        description: '与角色的特殊日子，支持翻页与倒数',
        size: {
            default: { w: 4, h: 2 },
            min: { w: 4, h: 2 },
            max: { w: 4, h: 3 },
        },
        capabilities: { opacity: true },
    },
    quad_apps: {
        kind: 'quad_apps',
        label: '四宫格风车组件',
        description: '经典四合一应用方块，收纳 4 个 App，支持直接拖入与点开管理',
        size: {
            default: { w: 2, h: 2 },
            min: { w: 2, h: 2 },
            max: { w: 2, h: 2 },
        },
        capabilities: { opacity: true },
    },
    weather: {
        kind: 'weather',
        label: '天气',
        description: '实时天气状况与温度体感，冷暖相伴',
        size: {
            default: { w: 2, h: 2 },
            min: { w: 2, h: 2 },
            max: { w: 4, h: 3 },
        },
        capabilities: { opacity: true },
    },
    app_folder: {
        kind: 'app_folder',
        label: '文件夹',
        description: '把一个 App 拖到另一个 App 上合成，点开看里面的 App',
        size: {
            default: { w: 1, h: 1 },
            min: { w: 1, h: 1 },
            max: { w: 1, h: 1 },
        },
        galleryHidden: true,
        iconCell: true,
    },
} as const satisfies Record<WidgetKind, WidgetDefinition>;

/**
 * 所有小组件定义清单，顺序即 Gallery 默认展示顺序。
 * 从 WIDGET_DEFINITION_MAP 派生。
 */
export const WIDGET_DEFINITIONS: ReadonlyArray<WidgetDefinition> = Object.values(WIDGET_DEFINITION_MAP);

/**
 * 所有当前合法 WidgetKind 列表。
 * 从 WIDGET_DEFINITIONS 派生，禁止手写第二份字符串名单。
 */
export const ALL_WIDGET_KINDS: ReadonlyArray<WidgetKind> = WIDGET_DEFINITIONS.map(d => d.kind);

// ───────────────────────── Runtime Validator ─────────────────────────

export function validateWidgetRegistry(
    definitions: ReadonlyArray<WidgetDefinition> = WIDGET_DEFINITIONS,
    runtimeKindKeys?: ReadonlyArray<string>,
): WidgetRegistryValidationResult {
    const errors: string[] = [];
    const seenKinds = new Set<string>();

    for (const def of definitions) {
        // V02: manifest 无重复 kind
        if (seenKinds.has(def.kind)) {
            errors.push(`V02: Duplicate definition for widget kind "${def.kind}"`);
        }
        seenKinds.add(def.kind);

        // V05: size 中所有值为 finite positive integer
        const { default: d, min, max } = def.size || {};
        const isPosInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;
        if (!isPosInt(d?.w) || !isPosInt(d?.h) || !isPosInt(min?.w) || !isPosInt(min?.h) || !isPosInt(max?.w) || !isPosInt(max?.h)) {
            errors.push(`V05: Size constraints for "${def.kind}" must contain finite positive integers`);
        } else {
            // V06: min <= default <= max
            if (min.w > d.w || d.w > max.w) {
                errors.push(`V06: Width constraint violated for "${def.kind}": min(${min.w}) <= default(${d.w}) <= max(${max.w})`);
            }
            if (min.h > d.h || d.h > max.h) {
                errors.push(`V06: Height constraint violated for "${def.kind}": min(${min.h}) <= default(${d.h}) <= max(${max.h})`);
            }
        }

        // V07: singleton / defaultLocked / capabilities 结构合法性校验
        if (def.singleton !== undefined && typeof def.singleton !== 'boolean') {
            errors.push(`V07: Invalid singleton field for "${def.kind}": expected boolean`);
        }
        if (def.iconCell !== undefined && typeof def.iconCell !== 'boolean') {
            errors.push(`V07: Invalid iconCell field for "${def.kind}": expected boolean`);
        }
        if (def.galleryHidden !== undefined && typeof def.galleryHidden !== 'boolean') {
            errors.push(`V07: Invalid galleryHidden field for "${def.kind}": expected boolean`);
        }
        if (def.defaultLocked !== undefined && typeof def.defaultLocked !== 'boolean') {
            errors.push(`V07: Invalid defaultLocked field for "${def.kind}": expected boolean`);
        }
        if (def.capabilities !== undefined) {
            if (typeof def.capabilities !== 'object' || def.capabilities === null || Array.isArray(def.capabilities)) {
                errors.push(`V07: Invalid capabilities field for "${def.kind}": expected object`);
            } else if (def.capabilities.opacity !== undefined && typeof def.capabilities.opacity !== 'boolean') {
                errors.push(`V07: Invalid opacity capability for "${def.kind}": expected boolean`);
            }
        }
    }

    // runtime binding 校验：确保 runtime 提供的 key 与 registered definitions 严格一致且无重复
    if (runtimeKindKeys) {
        const runtimeSet = new Set<string>();
        for (const k of runtimeKindKeys) {
            if (runtimeSet.has(k)) {
                errors.push(`V04: Duplicate runtime binding for kind "${k}"`);
            }
            runtimeSet.add(k);
        }
        for (const def of definitions) {
            if (!runtimeSet.has(def.kind)) {
                errors.push(`V03: Missing runtime binding for widget kind "${def.kind}"`);
            }
        }
        for (const k of runtimeSet) {
            if (!seenKinds.has(k)) {
                errors.push(`V03: Extraneous runtime binding for unregistered kind "${k}"`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

// 模块加载自检：快速捕获 manifest 内配置破坏
const _selfCheck = validateWidgetRegistry(WIDGET_DEFINITIONS);
if (!_selfCheck.valid) {
    throw new Error(`Widget registry invariant violation:\n${_selfCheck.errors.join('\n')}`);
}

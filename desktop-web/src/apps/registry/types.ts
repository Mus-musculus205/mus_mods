import { AppID } from '../../types';

export { AppID };

// ─────────────────────────────────────────────────────────────
// AppExposure — 桌面可见性 / 进入方式的权威标记
// ─────────────────────────────────────────────────────────────

/**
 * shell    — 常驻 shell 层（当前只有 Launcher），静态加载，不显示在桌面图标列表。
 * desktop  — 正常显示在桌面的 App。
 * hidden   — 不在桌面，但可以从其他 App 调用 openApp() 进入。
 *            （如 WorldHome、Browser、Handbook、QQBridge、VoiceDesigner）
 * dev-only — 只在 devDebug 可见时出现在桌面。（当前只有 CharCreatorDev）
 */
export type AppExposure = 'shell' | 'desktop' | 'hidden' | 'dev-only';

// ─────────────────────────────────────────────────────────────
// AppDefinition — 回答「这个 App 是谁？」
// ─────────────────────────────────────────────────────────────

/**
 * App 的稳定 manifest metadata。
 * 不包含 React component，不包含 persistence，不包含 module path。
 */
export interface AppDefinition {
    /** 目标版本已定义的 AppID。 */
    readonly id: AppID;

    /**
     * 用户可见的中文名，用于桌面图标、analytics、通知等。
     * shell App 不强制要求；exposure 为 hidden/desktop/dev-only 时必须提供。
     */
    readonly displayName?: string;

    /**
     * 对应 constants.tsx `Icons` map 的 key。
     * desktop / dev-only App 必须提供；hidden App 可选；shell App 不需要。
     */
    readonly iconKey?: string;

    /** 上游的主题色键。 */
    readonly color?: string;

    /** App 的桌面可见性 / 进入方式权威标记。 */
    readonly exposure: AppExposure;

    /**
     * 默认 Dock 排位（0 起，从左到右）。
     * undefined = 不在默认 Dock。
     */
    readonly defaultDockSlot?: number;

    /**
     * 人工描述（单行），供文档工具生成 docs/app-inventory.md。
     * 非 runtime 必须字段。
     */
    readonly description?: string;
}

/**
 * Desktop / dev-only 桌面可用 App 的类型视图。
 * V05 与 V07 Invariants 保证了这些 App 的 displayName 和 iconKey 必定为非空 string。
 */
export interface DesktopAppDefinition extends AppDefinition {
    readonly displayName: string;
    readonly iconKey: string;
    readonly exposure: 'desktop' | 'dev-only';
}


// ─────────────────────────────────────────────────────────────
// AppRuntimeBinding — 回答「这个 App 怎么加载和渲染？」
// ─────────────────────────────────────────────────────────────

/**
 * 普通 dynamic import：module 默认导出就是组件。
 * 绝大多数 App 属于此类。命名导出也在此类处理——在 loader 内部用 .then 适配成 { default }：
 *   loader: () => import('./ValentineEvent').then(m => ({ default: m.SpecialMomentsApp }))
 *
 * loader 返回 ComponentType<any> 而非 ComponentType<Record<string, never>>：
 * App 组件可以有自己的 props（如 WorldHomeApp.embedded），
 * 实际 props 传递由 getAppRenderInfo 中的 initialProps 控制，类型安全由调用点保证。
 */
export interface StandardRuntimeBinding {
    readonly kind: 'standard';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly loader: () => Promise<{ default: React.ComponentType<any> }>;
    /**
     * idle preload 优先级，数字越小越先。
     * undefined = 不参与 idle preload。
     * 必须为 >= 1 的整数，不允许重复（defineAppRegistry V15 校验）。
     * 不要求连续：表示排序优先级而非 ordinal。
     */
    readonly idlePreloadPriority?: number;
}

/**
 * 共享 module：与另一个 AppID 共用同一个组件，可附加固定的初始 props。
 * primaryAppId 必须对应一个 standard binding（defineAppRegistry V11 校验）。
 */
export interface SharedModuleRuntimeBinding {
    readonly kind: 'shared-module';
    /** 拥有 lazy component 的主 AppID（必须对应 standard binding）。 */
    readonly primaryAppId: AppID;
    /** 传给共享组件的固定初始 props。 */
    readonly initialProps?: Record<string, unknown>;
    readonly idlePreloadPriority?: number;
}

/**
 * 静态 import（shell 专用）：已经在 PhoneShell 顶层静态 import，
 * 不走 lazy，不走 Suspense，不进入 preloadableMap。
 * 只有 Launcher 是这一种（defineAppRegistry V12 校验：static 仅限 shell exposure）。
 */
export interface StaticRuntimeBinding {
    readonly kind: 'static';
}

export type AppRuntimeBinding =
    | StandardRuntimeBinding
    | SharedModuleRuntimeBinding
    | StaticRuntimeBinding;


// ─────────────────────────────────────────────────────────────
// AppRegistryEntry — manifest + runtime 的完整条目
// ─────────────────────────────────────────────────────────────

export interface AppRegistryEntry {
    readonly definition: AppDefinition;
    readonly runtime: AppRuntimeBinding;
}

// ─────────────────────────────────────────────────────────────
// RegistryValidationResult — defineAppRegistry 的检查结果
// ─────────────────────────────────────────────────────────────

export interface RegistryValidationResult {
    readonly valid: boolean;
    readonly errors: ReadonlyArray<string>;
}

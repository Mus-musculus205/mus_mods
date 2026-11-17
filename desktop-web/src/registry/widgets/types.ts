import type { WidgetKind } from './layout';

export interface WidgetSizeConstraint {
    readonly default: {
        readonly w: number;
        readonly h: number;
    };
    readonly min: {
        readonly w: number;
        readonly h: number;
    };
    readonly max: {
        readonly w: number;
        readonly h: number;
    };
}

export interface WidgetCapabilities {
    readonly opacity?: boolean;
}

export interface WidgetDefinition {
    readonly kind: WidgetKind;
    readonly label: string;
    readonly description: string;
    readonly size: WidgetSizeConstraint;
    readonly singleton?: boolean;
    readonly defaultLocked?: boolean;
    readonly capabilities?: WidgetCapabilities;
    /** 不在小组件库里出现（只能由别的操作生成，如把 App 拖到 App 上合成文件夹）。 */
    readonly galleryHidden?: boolean;
    /** 在格子里按 App 图标的方式摆放（居中、同样大小的图标 + 下方名字），如文件夹。 */
    readonly iconCell?: boolean;
}

export interface WidgetRegistryValidationResult {
    readonly valid: boolean;
    readonly errors: ReadonlyArray<string>;
}

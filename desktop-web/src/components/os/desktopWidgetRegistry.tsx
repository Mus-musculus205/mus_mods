import React from 'react';
import type { CharacterProfile, DailySchedule, Anniversary, Task } from '../../types';
import type { WidgetKind, PlacedItem } from '../../registry/widgets/layout';
import { AppID, APP_REGISTRY, getDesktopAppDefinition } from '../../apps/registry';
import AppIcon from './AppIcon';
import NowPlayingSquareWidget from './NowPlayingSquareWidget';
import { ScheduleHomeWidget } from '../schedule/ScheduleHomeWidget';
import { CalendarWidget } from './widgets/CalendarWidget';
import { AnniversaryWidget } from './widgets/AnniversaryWidget';
import { DesktopImageWidget } from './widgets/DesktopImageWidget';
import { QuadAppsWidget } from './widgets/QuadAppsWidget';
import { WeatherWidget } from './widgets/WeatherWidget';
import { AppFolderWidget } from './widgets/AppFolderWidget';
import {
    WIDGET_DEFINITIONS,
    validateWidgetRegistry,
} from '../../registry/widgets';

/**
 * 桌面自由网格 · 组件运行时渲染上下文。
 * 纯运行时环境载体，由 Launcher 汇总各 Domain 状态并注入。
 */
export interface WidgetRenderContext {
    contentColor: string;
    acnh: boolean;
    paper: boolean;
    /** 编辑态（长按整理）中。锁定项在编辑态也不响应内容点击。 */
    editing: boolean;
    openApp: (id: string) => void;

    // 数据（Launcher 从 OSContext / DB 取好后传进来）
    anniversaries: Anniversary[];
    tasks?: Task[];
    characters: CharacterProfile[];
    /** weather 用：当前主屏激活角色 */
    widgetChar?: CharacterProfile | null;
    /** schedule 用 */
    scheduleData: DailySchedule | null;
    scheduleChar: CharacterProfile | null;
    onOpenSchedule: () => void;
    /** image 用：点一下换图 */
    onEditImage: (item: PlacedItem) => void;
    /** 由 Launcher 统一持久化条目配置，组件不得直接写 theme。 */
    onUpdateItemConfig?: (item: PlacedItem, patch: Record<string, unknown>) => void;
    /** quad_apps 用：打开四宫格应用管理抽屉 */
    onOpenQuadManager?: (item: PlacedItem, slotIndex?: number) => void;
    /** quad_apps 用：单独移除某个槽位的应用 */
    onRemoveQuadApp?: (item: PlacedItem, slotIndex: number) => void;
    /** quad_apps 用：单独为某个槽位添加应用 */
    onAddQuadApp?: (item: PlacedItem, slotIndex: number) => void;
    /** app_folder 用：点开文件夹弹层 */
    onOpenFolder?: (item: PlacedItem) => void;
    /** 小组件背景透明度字典 (0~100) */
    widgetOpacity?: Partial<Record<WidgetKind, number>>;
    /** 当前自由网格 cell 的图标像素尺寸。 */
    appIconSizePx?: number;
}

export type WidgetRenderer = (item: PlacedItem, ctx: WidgetRenderContext) => React.ReactNode;

/**
 * Widget Runtime 映射表：WidgetKind → React renderer。
 * 严格覆盖且仅覆盖当前已注册自由网格小组件（WidgetKind）。
 * clock / charCard 不属于网格小组件，由 Launcher 主屏 Header 单独渲染，严禁在此注册。
 */
export const WIDGET_RUNTIMES: Record<WidgetKind, WidgetRenderer> = {
    quad_apps: (item, ctx) => (
        <QuadAppsWidget
            apps={item.config?.apps}
            openApp={ctx.openApp}
            editing={ctx.editing}
            contentColor={ctx.contentColor}
            acnh={ctx.acnh}
            paper={ctx.paper}
            onOpenManager={(slotIndex) => ctx.onOpenQuadManager?.(item, slotIndex)}
            opacity={item.config?.opacity ?? ctx.widgetOpacity?.quad_apps ?? 100}
        />
    ),
    schedule: (item, ctx) => {
        if (!ctx.scheduleChar) return null;
        return (
            <div className={`h-full w-full ${ctx.editing ? 'pointer-events-none' : ''}`}
                style={{ opacity: (item.config?.opacity ?? ctx.widgetOpacity?.schedule ?? 100) / 100 }}>
                <ScheduleHomeWidget
                    schedule={ctx.scheduleData}
                    character={ctx.scheduleChar}
                    contentColor={ctx.contentColor}
                    onOpen={ctx.onOpenSchedule}
                    acnh={ctx.acnh}
                    paper={ctx.paper}
                />
            </div>
        );
    },
    music: (item, ctx) => (
        <div className={`h-full w-full ${ctx.editing ? 'pointer-events-none' : ''}`}
            style={{ opacity: (item.config?.opacity ?? ctx.widgetOpacity?.music ?? 100) / 100 }}>
            <NowPlayingSquareWidget contentColor={ctx.contentColor} />
        </div>
    ),
    image: (item, ctx) => (
        <DesktopImageWidget
            image={item.config?.src}
            contentColor={ctx.contentColor}
            onClick={() => { if (!ctx.editing) ctx.onEditImage(item); }}
            acnh={ctx.acnh}
        />
    ),
    calendar: (_item, ctx) => (
        <CalendarWidget
            contentColor={ctx.contentColor}
            openApp={ctx.openApp}
            anniversaries={ctx.anniversaries}
            tasks={ctx.tasks}
            acnh={ctx.acnh}
            paper={ctx.paper}
            editing={ctx.editing}
            opacity={_item.config?.opacity ?? ctx.widgetOpacity?.calendar ?? 100}
        />
    ),
    anniversary: (_item, ctx) => (
        <AnniversaryWidget
            contentColor={ctx.contentColor}
            openApp={ctx.openApp}
            anniversaries={ctx.anniversaries}
            tasks={ctx.tasks}
            characters={ctx.characters}
            acnh={ctx.acnh}
            paper={ctx.paper}
            editing={ctx.editing}
            opacity={_item.config?.opacity ?? ctx.widgetOpacity?.anniversary ?? 100}
        />
    ),
    weather: (item, ctx) => <WeatherWidget item={item} ctx={ctx} />,
    app_folder: (item, ctx) => (
        <AppFolderWidget
            item={item}
            iconPx={ctx.appIconSizePx}
            contentColor={ctx.contentColor}
            acnh={ctx.acnh}
            paper={ctx.paper}
            onOpen={() => ctx.onOpenFolder?.(item)}
        />
    ),
};

// 运行时契约自检：确保 WIDGET_RUNTIMES 与 manifest (ALL_WIDGET_KINDS) 严格一一对应
const _runtimeCheck = validateWidgetRegistry(WIDGET_DEFINITIONS, Object.keys(WIDGET_RUNTIMES));
if (!_runtimeCheck.valid) {
    throw new Error(`Widget runtime invariant violation:\n${_runtimeCheck.errors.join('\n')}`);
}

/**
 * 渲染真正自由网格小组件的内容。
 */
export const renderWidgetContent = (
    item: PlacedItem,
    ctx: WidgetRenderContext,
): React.ReactNode => {
    const renderer = WIDGET_RUNTIMES[item.kind as WidgetKind];
    if (!renderer) return null;
    return renderer(item, ctx);
};

/**
 * 宿主层网格条目渲染器（Desktop Grid Dispatcher）：
 * - app: 由 Desktop Grid / App Registry 路径渲染 AppIcon
 * - WidgetKind: 由 Widget runtime binding 渲染对应组件
 */
export const renderGridItemContent = (
    item: PlacedItem,
    ctx: WidgetRenderContext,
): React.ReactNode => {
    if (item.kind === 'app') {
        const app = getDesktopAppDefinition(APP_REGISTRY, item.refId as AppID);
        if (!app) return null;
        return (
            <AppIcon
                app={app}
                onClick={() => { if (!ctx.editing) ctx.openApp(app.id); }}
                disabled={ctx.editing}
                size="md"
                iconPx={ctx.appIconSizePx}
            />
        );
    }
    return renderWidgetContent(item, ctx);
};

/** 桌面自由小组件类型定义（唯一当前 Widget 身份 Authority）。 */
export type WidgetKind =
  | 'schedule'
  | 'music'
  | 'image'
  | 'calendar'
  | 'anniversary'
  | 'quad_apps'
  | 'weather'
  | 'app_folder';

/** 网格条目类型。'app' 用 refId 存 AppID；其余为真正的自由网格小组件。 */
export type GridItemKind = 'app' | WidgetKind;

/** 网格上的一个条目。x/y 是左上角格子坐标（0 起），w/h 是横竖占用格数。 */
export interface PlacedItem {
  id: string;
  kind: GridItemKind;
  /** kind==='app' 时为 AppID；其余类型忽略。 */
  refId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 实例锁定状态（锁定后不可拖动 / 改大小 / 删除；编辑态点徽标切换）。
   * 新建 Widget 时可根据 Widget Registry 的 defaultLocked 初始化；
   * 之后由实例状态独立保存和修改。
   */
  locked?: boolean;
  title?: string;
  config?: Record<string, any>;
}

export interface DesktopPage {
  id: string;
  items: PlacedItem[];
  /**
   * 页面规格：'windmill' 为 4×6，'standard' 为 4×7；
   * 'home' 是主屏表头（时钟+角色卡）专属标记。DesktopLayout 必须恰好有一个 home。
   */
  layout: 'windmill' | 'standard' | 'home';
}

/**
 * 默认桌面的唯一布局数据源（唯一桌面布局 Authority）。
 *
 * `pages` 保存自由网格，`dock` 保存底栏 App ID（最多四个）。两处 App 必须互斥：
 * 一个 App 在 Dock 中时不再作为网格条目或四宫格条目出现。
 */
export interface DesktopLayout {
  version: 1;
  pages: DesktopPage[];
  dock: string[];
}

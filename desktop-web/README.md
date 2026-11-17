# Desktop Web for SullyOS

网页桌面的源码增量，包含自由网格、Dock、四宫格、文件夹、跨页拖拽、分页按钮和键盘导航。按 `src/` 下的相对路径取用，接入点按你使用的 SullyOS 版本手动合并。

包里的 App 清单和加载入口取自仍采用 PolyForm Noncommercial 1.0.0 的 [公开上游版本](https://github.com/qegj567-cloud/SullyOS/tree/79c3e22bb9d01a653dbf457b5ac6cc5d7a322e1b)。App 继续由目标项目提供。小组件用目标项目的日程、音乐、角色、任务、纪念日和天气数据。四宫格与文件夹从 App 注册表选择和打开已有 App。

## 包内容

| 路径 | 内容 |
| :--- | :--- |
| `src/apps/registry/` | 复用上游 `AppID`，集中声明 App、桌面可见性、默认 Dock 和组件加载入口 |
| `src/registry/widgets/` | 布局类型、小组件尺寸、锁定、透明度和组件库可见性 |
| `src/apps/Launcher.tsx`、`src/components/os/` | 桌面宿主、拖拽、分页、外观选择和小组件渲染 |
| `src/utils/desktop*.ts` | 网格定位、布局校验、App 文件夹和 Dock 移动的逻辑及测试 |
| `src/hooks/`、`src/styles/` | 桌面输入能力检测、键盘滚动和滚动条样式 |

组件库包含日程、音乐、相框、日历、纪念日、四宫格和天气。主屏时钟和角色卡跟随主屏布局。拖动 App 到另一个 App 上可创建文件夹。日程和音乐复用 `ScheduleHomeWidget` 与 `NowPlayingSquareWidget`，天气复用上游的全局天气配置。

## 手动合并

1. 对照 `apps/registry/manifest.ts` 和 `runtime.tsx` 检查目标 `types.ts` 的 AppID、可见性、图标键和 loader。把 `constants.tsx` 的桌面清单和默认 Dock 改成从注册表派生。若该版本仍消费 `AppConfig`，把 `displayName`、`iconKey` 和 `color` 映射回原有字段。沿用 `PhoneShell` 的原有路由和预取逻辑，或通过 `APP_RUNTIME_BINDINGS` 取 loader 后交给它现有的 lazy 封装。
2. 合并 `apps/Launcher.tsx` 和 `components/os/AppIcon.tsx`。这些路径可能与目标版本重叠。目标版本如果有 `staticPreview`、分享卡预览、特有皮肤或自定义图标入口，在合并时沿用对应分支。`useLauncherWidgetData.ts` 通过目标项目的 `DB` 和日程服务取数据，可按版本调整调用。
3. 在目标 `types.ts` 的 `OSTheme` 中接入下面三个可选字段，用其已有的 `updateTheme` 保存。要迁移老桌面时，在第一次保存 `launcherLayout` 前按旧主题的 `launcherAppOrder`、`launcherDockOrder`、`launcherPinwheelOrder` 和 `launcherWidgets` 建立初始布局。相框的旧图片或 Blob 引用对应网格条目的 `config.src`。包中的 `resolveDesktopLayout` 会校验自由网格布局并提供默认值，旧字段的转换由接入方完成。

   ```ts
   import type { DesktopLayout, WidgetKind } from './registry/widgets/layout';

   // 加到已有的 OSTheme 接口中
   launcherLayout?: DesktopLayout;
   launcherStartPageId?: string;
   widgetOpacity?: Partial<Record<WidgetKind, number>>;
   ```

4. 把 `styles/desktop-scrollbars.css` 加到目标工程的样式入口。在 App 根组件中用 `useIsDesktopMode()` 的结果同步 `document.documentElement.classList.toggle('is-desktop', isDesktop)`，卸载时移除 class。要给已有长列表加键盘滚动，就在对应视图调用 `useArrowScroll` 并加 `desktop-scrollbar`。弹窗和多选时通过 `blocked` 让出键盘操作。

选取 App 时建议查询同一份注册表，避免四宫格或文件夹保存到目标版本缺失的入口。旧的上游页面和仓库依赖由目标工程提供。

## 验证

合并后在目标项目中可运行包里的测试，覆盖布局、文件夹、分页、键盘行为和相框组件。

```powershell
pnpm vitest run --minWorkers=1 --maxWorkers=2 utils/desktopGrid.test.ts utils/desktopFolders.test.ts utils/useDeviceMode.test.ts utils/useArrowScroll.test.ts components/os/launcher/launcherPaging.test.tsx components/os/launcher/useLauncherPaging.test.tsx components/os/widgets/DesktopImageWidget.test.tsx
```

`.tsx` 测试文件使用 jsdom 环境。目标项目的 `vitest.config.ts` 若只收集 `utils/**/*.test.ts`，需在 `test.include` 中加入 `components/**/*.test.tsx`。

整合后可用一份已有桌面配置检查首次打开时的 App 顺序、Dock 顺序和相框图片，再检查触屏滑页、鼠标拖拽和键盘翻页。

## License

采用 PolyForm Noncommercial License 1.0.0。分发时请附带 [LICENSE](./LICENSE) 并保留全部 `Required Notice:` 行。

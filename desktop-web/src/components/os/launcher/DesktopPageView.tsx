import React from 'react';
import type { CharacterProfile } from '../../../types';
import type { DesktopPage, PlacedItem } from '../../../registry/widgets/layout';
import type { WidgetRenderContext } from '../desktopWidgetRegistry';
import { CharacterCardWidget } from '../widgets/CharacterCardWidget';
import { DesktopClockWidget } from '../widgets/DesktopClockWidget';
import {
  DesktopGridSurface,
  type DesktopDragPreview,
  type DockDropPreview,
} from './DesktopGridSurface';
import { PAGE_PAD_X } from './launcherGeometry';

interface DesktopPageViewProps {
  page: DesktopPage;
  pageIndex: number;
  gridWidthPx: number;
  cellPx: number;
  layoutEditing: boolean;
  widgetCtx: WidgetRenderContext;
  onItemPointerDown: (event: React.PointerEvent, item: PlacedItem, pageIndex: number) => void;
  handleToggleLock: (pageIndex: number, itemId: string) => void;
  handleDeleteItem: (pageIndex: number, itemId: string) => void;
  onResizePointerDown: (event: React.PointerEvent, item: PlacedItem, pageIndex: number) => void;
  dragPreview: DesktopDragPreview | null;
  registerPageGridRef: (pageIndex: number, element: HTMLDivElement | null) => void;
  widgetChar: CharacterProfile | null;
  widgetUnread: number;
  lastMessage: string;
  onOpenChat: () => void;
  contentColor: string;
  paper: boolean;
  dockDropPreview?: DockDropPreview | null;
}

export const DesktopPageView: React.FC<DesktopPageViewProps> = React.memo(({
  page,
  pageIndex,
  gridWidthPx,
  cellPx,
  layoutEditing,
  widgetCtx,
  onItemPointerDown,
  handleToggleLock,
  handleDeleteItem,
  onResizePointerDown,
  dragPreview,
  registerPageGridRef,
  widgetChar,
  widgetUnread,
  lastMessage,
  onOpenChat,
  contentColor,
  paper,
  dockDropPreview,
}) => {
  const isHomePage = page.layout === 'home';
  const isWindmillPage = page.layout === 'windmill';
  const pagePaddingClass = isWindmillPage ? 'pt-2 pb-4' : 'pt-10 pb-8';

  return (
    <div
      className={`w-full flex-shrink-0 snap-center snap-always h-full flex flex-col ${pagePaddingClass}`}
      style={{ contain: 'layout' }}
    >
      {isHomePage && (
        <div
          className="shrink-0 w-full mx-auto"
          style={{
            maxWidth: `${gridWidthPx + PAGE_PAD_X * 2}px`,
            paddingInline: `${PAGE_PAD_X}px`,
          }}
        >
          <DesktopClockWidget />
          <CharacterCardWidget
            char={widgetChar}
            unreadCount={widgetUnread}
            lastMessage={lastMessage}
            onClick={onOpenChat}
            contentColor={contentColor}
            paper={paper}
          />
        </div>
      )}

      <div
        className="flex-1 min-h-0 overflow-visible flex flex-col"
        style={{ paddingInline: `${PAGE_PAD_X}px` }}
      >
        <DesktopGridSurface
          page={page}
          pageIndex={pageIndex}
          gridWidthPx={gridWidthPx}
          cellPx={cellPx}
          layoutEditing={layoutEditing}
          widgetCtx={widgetCtx}
          onItemPointerDown={onItemPointerDown}
          handleToggleLock={handleToggleLock}
          handleDeleteItem={handleDeleteItem}
          onResizePointerDown={onResizePointerDown}
          dragPreview={dragPreview}
          registerPageGridRef={registerPageGridRef}
          dockDropPreview={dockDropPreview}
          verticallyCentered={isWindmillPage}
        />
      </div>
    </div>
  );
});

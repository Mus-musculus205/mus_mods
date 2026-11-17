import React from 'react';
import { ArrowsOutSimple, Lock, LockOpen, Plus, X } from '@phosphor-icons/react';
import type { DesktopPage, PlacedItem } from '../../../registry/widgets/layout';
import { GRID_COLS, rowsForScreen } from '../../../utils/desktopGrid';
import { canResizeWidget, isWidgetDefaultLocked, rendersAsIconCell } from '../../../registry/widgets';
import {
  renderGridItemContent,
  type WidgetRenderContext,
} from '../desktopWidgetRegistry';
import { GRID_COL_GAP, GRID_ROW_GAP, cellHeightFor } from './launcherGeometry';

export const EDIT_DELETE_BADGE_CLASS = 'absolute top-1 right-1 z-30 w-5 h-5 rounded-full bg-slate-900/85 text-white flex items-center justify-center shadow-md active:scale-90 hover:bg-slate-950 transition cursor-pointer before:absolute before:-inset-2 before:content-[\'\']';

export interface DesktopDragPreview {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ok: boolean;
  dropToQuad?: {
    quadId: string;
    pageIndex: number;
    slotIndex: number;
  };
  /** 停在 App / 文件夹中间：create = 两个 App 合成新文件夹，add = 放进已有文件夹 */
  dropToFolder?: {
    targetId: string;
    mode: 'create' | 'add';
  };
  displacements?: Map<string, { x: number; y: number }>;
}

export interface DockDropPreview {
  pageIndex: number;
  x: number;
  y: number;
  ok: boolean;
}

interface DesktopGridSurfaceProps {
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
  dockDropPreview?: DockDropPreview | null;
  verticallyCentered?: boolean;
}

export const DesktopGridSurface: React.FC<DesktopGridSurfaceProps> = React.memo(({
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
  dockDropPreview,
  verticallyCentered = false,
}) => {
  const rows = rowsForScreen(page);
  const cellHeight = cellHeightFor(cellPx);

  return (
    <div
      ref={element => registerPageGridRef(pageIndex, element)}
      data-desktop-grid
      className={`relative grid mx-auto ${verticallyCentered ? 'my-auto' : ''}`}
      style={{
        columnGap: `${GRID_COL_GAP}px`,
        rowGap: `${GRID_ROW_GAP}px`,
        width: `${gridWidthPx}px`,
        gridTemplateColumns: `repeat(${GRID_COLS}, ${cellPx}px)`,
        gridTemplateRows: `repeat(${rows}, ${cellHeight}px)`,
        gridAutoRows: `${cellHeight}px`,
      }}
    >
      {page.items.map(item => {
        const content = renderGridItemContent(item, widgetCtx);
        if (content == null) return null;
        const isDraggable = layoutEditing && !item.locked;
        const iconCell = rendersAsIconCell(item.kind);
        const displacedPosition = dragPreview?.pageIndex === pageIndex
          ? dragPreview.displacements?.get(item.id)
          : undefined;
        const deltaX = displacedPosition
          ? (displacedPosition.x - item.x) * (cellPx + GRID_COL_GAP)
          : 0;
        const deltaY = displacedPosition
          ? (displacedPosition.y - item.y) * (cellHeight + GRID_ROW_GAP)
          : 0;
        const isDisplaced = displacedPosition !== undefined && (deltaX !== 0 || deltaY !== 0);

        return (
          <div
            key={item.id}
            data-grid-item={item.id}
            data-grid-kind={item.kind}
            className={`relative min-w-0 min-h-0 ${iconCell ? 'flex items-center justify-center' : ''}`}
            style={{
              gridColumn: `${item.x + 1} / span ${item.w}`,
              gridRow: `${item.y + 1} / span ${item.h}`,
              transform: isDisplaced ? `translate3d(${deltaX}px, ${deltaY}px, 0)` : 'translate3d(0px, 0px, 0)',
              transition: layoutEditing ? 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1.15)' : undefined,
              zIndex: isDisplaced ? 15 : undefined,
              willChange: layoutEditing ? 'transform' : undefined,
            }}
            onPointerDown={event => onItemPointerDown(event, item, pageIndex)}
            onClickCapture={event => {
              if (layoutEditing && item.kind === 'app' && !(event.target as HTMLElement).closest('[data-grid-action]')) {
                event.stopPropagation();
                event.preventDefault();
              }
            }}
          >
            <div className={`w-full h-full overflow-visible ${iconCell ? 'flex items-center justify-center' : ''} ${isDraggable ? 'launcher-edit-wobble' : ''}`}>
              {content}
            </div>

            {layoutEditing && (
              item.locked ? (
                <button
                  data-grid-action="lock"
                  onClick={event => { event.stopPropagation(); handleToggleLock(pageIndex, item.id); }}
                  className="absolute top-1 left-1 w-7 h-7 rounded-full bg-slate-700 text-white flex items-center justify-center shadow-md active:scale-90 z-30"
                  title="已锁定 · 点击解锁"
                >
                  <Lock size={13} weight="fill" />
                </button>
              ) : (
                <>
                  <button
                    data-grid-action="delete"
                    onClick={event => { event.stopPropagation(); handleDeleteItem(pageIndex, item.id); }}
                    className={EDIT_DELETE_BADGE_CLASS}
                    title="移除"
                  >
                    <X size={11} weight="bold" />
                  </button>
                  {isWidgetDefaultLocked(item.kind) && (
                    <button
                      data-grid-action="lock"
                      onClick={event => { event.stopPropagation(); handleToggleLock(pageIndex, item.id); }}
                      className="absolute top-1 left-1 w-6 h-6 rounded-full bg-slate-500 text-white flex items-center justify-center shadow-md active:scale-90 z-30 before:absolute before:-inset-2 before:content-['']"
                      title="锁定"
                    >
                      <LockOpen size={11} weight="fill" />
                    </button>
                  )}
                  {canResizeWidget(item.kind) && (
                    <button
                      data-grid-action="resize"
                      onPointerDown={event => onResizePointerDown(event, item, pageIndex)}
                      style={{ touchAction: 'none' }}
                      className="absolute bottom-1 right-1 w-7 h-7 rounded-full bg-white/90 text-slate-700 flex items-center justify-center shadow-md active:scale-90 z-30 cursor-nwse-resize"
                      title="拖动改大小"
                    >
                      <ArrowsOutSimple size={13} weight="bold" />
                    </button>
                  )}
                </>
              )
            )}
          </div>
        );
      })}

      {dragPreview?.pageIndex === pageIndex && (
        dragPreview.dropToFolder ? (
          <div
            className="pointer-events-none rounded-[1.4rem] z-20 flex items-end justify-center pb-0.5 animate-pulse"
            style={{
              gridColumn: `${dragPreview.x + 1} / span 1`,
              gridRow: `${dragPreview.y + 1} / span 1`,
              background: 'rgba(255,255,255,0.22)',
              boxShadow: '0 0 0 2px rgba(255,255,255,0.75), 0 0 22px rgba(255,255,255,0.35)',
            }}
          >
            <span className="px-2 py-0.5 rounded-full bg-slate-900/75 text-white text-[10px] font-bold shadow">
              {dragPreview.dropToFolder.mode === 'create' ? '合成文件夹' : '放入文件夹'}
            </span>
          </div>
        ) : dragPreview.dropToQuad ? (
          <div
            className="pointer-events-none rounded-3xl border-2 border-dashed z-20 transition-all duration-150 flex items-center justify-center animate-pulse"
            style={{
              gridColumn: `${dragPreview.x + 1} / span ${dragPreview.w}`,
              gridRow: `${dragPreview.y + 1} / span ${dragPreview.h}`,
              borderColor: 'rgba(45, 212, 191, 0.95)',
              background: 'rgba(45, 212, 191, 0.16)',
              boxShadow: '0 0 24px rgba(45, 212, 191, 0.35)',
            }}
          >
            <div className="px-3 py-1 rounded-full bg-teal-500 text-white text-[11px] font-bold shadow-lg tracking-wider flex items-center gap-1">
              <Plus size={12} weight="bold" />
              <span>放入四宫格</span>
            </div>
          </div>
        ) : (
          <div
            className="pointer-events-none rounded-2xl border-2 border-dashed z-20 launcher-drag-placeholder"
            style={{
              gridColumn: `${dragPreview.x + 1} / span ${dragPreview.w}`,
              gridRow: `${dragPreview.y + 1} / span ${dragPreview.h}`,
              borderColor: dragPreview.ok ? 'rgba(255,255,255,0.7)' : 'rgba(239,68,68,0.8)',
              background: dragPreview.ok ? 'rgba(255,255,255,0.12)' : 'rgba(239,68,68,0.12)',
            }}
          />
        )
      )}
      {dockDropPreview?.pageIndex === pageIndex && (
        <div
          className="pointer-events-none rounded-2xl border-2 border-dashed z-20 launcher-drag-placeholder"
          style={{
            gridColumn: `${dockDropPreview.x + 1} / span 1`,
            gridRow: `${dockDropPreview.y + 1} / span 1`,
            borderColor: dockDropPreview.ok ? 'rgba(255,255,255,0.75)' : 'rgba(239,68,68,0.8)',
            background: dockDropPreview.ok ? 'rgba(255,255,255,0.12)' : 'rgba(239,68,68,0.12)',
          }}
        />
      )}
    </div>
  );
});

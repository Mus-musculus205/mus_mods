import React, { useEffect, useRef, useState } from 'react';
import type { PlacedItem } from '../../../registry/widgets/layout';
import { AppID, APP_REGISTRY, getDesktopAppDefinition } from '../../../apps/registry';
import { readFolderConfig } from '../../../utils/desktopFolders';
import AppIcon from '../AppIcon';
import { createDragGhost } from './launcherDragGhost';

interface AppFolderOverlayProps {
  folder: PlacedItem;
  acnh: boolean;
  paper: boolean;
  contentColor: string;
  onClose: () => void;
  onOpenApp: (appId: string) => void;
  onRename: (name: string) => void;
  onReorder: (apps: string[]) => void;
  /** 拖出面板松手：把 App 移到桌面上松手的位置附近。 */
  onDragOut: (appId: string, clientX: number, clientY: number) => void;
}

const DRAG_START_PX = 8;

/**
 * 点开文件夹后的弹层：上面是可改的名字，下面 4 列排 App。
 * 轻点打开 App；按住拖动可在面板里换位置，拖出面板松手就移到桌面上。
 */
export const AppFolderOverlay: React.FC<AppFolderOverlayProps> = ({
  folder, acnh, paper, contentColor, onClose, onOpenApp, onRename, onReorder, onDragOut,
}) => {
  const { name, apps } = readFolderConfig(folder);
  const [draftName, setDraftName] = useState(name);
  const [order, setOrder] = useState(apps);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [outside, setOutside] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<null | {
    pointerId: number; appId: string; startX: number; startY: number;
    moved: boolean; ghost?: HTMLElement; offsetX: number; offsetY: number; cell: HTMLElement;
  }>(null);
  // 拖完松手后浏览器可能补发一次 click，短时间内吞掉，免得拖完顺手打开了 App
  const suppressClickUntil = useRef(0);

  // 文件夹内容被别处改了（如拖出后解散前的那一帧）时跟上最新顺序
  const appsKey = apps.join('|');
  useEffect(() => { setOrder(apps); }, [appsKey]);
  useEffect(() => { setDraftName(name); }, [name]);

  useEffect(() => () => { drag.current?.ghost?.remove(); }, []);

  const commitName = () => {
    if (draftName.trim() !== name) onRename(draftName);
  };

  const isOutsidePanel = (x: number, y: number) => {
    const rect = panelRef.current!.getBoundingClientRect();
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
  };

  const onCellPointerDown = (event: React.PointerEvent<HTMLDivElement>, appId: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const cell = event.currentTarget;
    const rect = cell.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId, appId, startX: event.clientX, startY: event.clientY,
      moved: false, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, cell,
    };
    cell.setPointerCapture(event.pointerId);
  };

  const onCellPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    if (!d.moved) {
      if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) <= DRAG_START_PX) return;
      d.moved = true;
      const { ghost } = createDragGhost(d.cell, {
        hitTestAttribute: 'data-folder-app',
        style: { zIndex: '10001', transform: 'scale(1.08)', opacity: '0.95' },
      });
      d.ghost = ghost;
      setDraggingId(d.appId);
    }
    d.ghost!.style.left = `${event.clientX - d.offsetX}px`;
    d.ghost!.style.top = `${event.clientY - d.offsetY}px`;
    const out = isOutsidePanel(event.clientX, event.clientY);
    setOutside(out);
    if (out) return;
    // 面板里：手指落在哪个格子上，被拖的 App 就挪到那个位置
    const overId = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-folder-app]')?.dataset.folderApp;
    if (!overId || overId === d.appId) return;
    setOrder(prev => {
      const from = prev.indexOf(d.appId);
      const to = prev.indexOf(overId);
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, d.appId);
      return next;
    });
  };

  const onCellPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    d.ghost?.remove();
    setDraggingId(null);
    setOutside(false);
    if (!d.moved) return;
    suppressClickUntil.current = Date.now() + 400;
    if (event.type !== 'pointercancel' && isOutsidePanel(event.clientX, event.clientY)) {
      onDragOut(d.appId, event.clientX, event.clientY);
      return;
    }
    if (order.join('|') !== apps.join('|')) onReorder(order);
  };

  const panelStyle: React.CSSProperties = paper
    ? { background: 'rgba(245,240,230,0.92)', color: '#4b4136' }
    : acnh
      ? { background: 'rgba(247,243,223,0.97)', color: '#725d42' }
      : { background: 'rgba(255,255,255,0.18)', color: contentColor, border: '1px solid rgba(255,255,255,0.3)' };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 backdrop-blur-md animate-fade-in"
      onClick={(event) => { if (event.target === event.currentTarget) { commitName(); onClose(); } }}
    >
      <div
        ref={panelRef}
        className={`w-[86%] max-w-[22rem] rounded-[2rem] px-4 pt-4 pb-5 shadow-2xl backdrop-blur-2xl transition-opacity ${outside ? 'opacity-40' : ''}`}
        style={panelStyle}
      >
        <input
          value={draftName}
          onChange={event => setDraftName(event.target.value)}
          onBlur={commitName}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              (event.target as HTMLInputElement).blur();
            }
          }}
          maxLength={24}
          aria-label="文件夹名称"
          className="w-full bg-transparent text-center text-lg font-bold outline-none mb-4 rounded-xl py-1 focus:bg-black/10"
          style={{ color: 'inherit' }}
        />
        <div className="grid grid-cols-4 gap-y-4 place-items-center">
          {order.map(appId => {
            const app = getDesktopAppDefinition(APP_REGISTRY, appId as AppID);
            if (!app) return null;
            return (
              <div
                key={appId}
                data-folder-app={appId}
                className={`touch-none select-none transition-opacity ${draggingId === appId ? 'opacity-25' : ''}`}
                onPointerDown={event => onCellPointerDown(event, appId)}
                onPointerMove={onCellPointerMove}
                onPointerUp={onCellPointerUp}
                onPointerCancel={onCellPointerUp}
                onClickCapture={event => {
                  if (Date.now() > suppressClickUntil.current) return;
                  event.stopPropagation();
                  event.preventDefault();
                }}
              >
                <AppIcon app={app} onClick={() => onOpenApp(app.id)} size="md" />
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-center text-[10px] opacity-60">按住拖动换位置，拖出框外就放回桌面</p>
      </div>
    </div>
  );
};

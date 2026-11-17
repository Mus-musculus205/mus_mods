import React from 'react';
import { X } from '@phosphor-icons/react';
import type { AppID, DesktopAppDefinition } from '../../../apps/registry';
import AppIcon from '../AppIcon';
import { EDIT_DELETE_BADGE_CLASS } from './DesktopGridSurface';

interface LauncherDockProps {
  dockApps: ReadonlyArray<DesktopAppDefinition>;
  totalUnread: number;
  openApp: (id: AppID) => void;
  acnh: boolean;
  paper: boolean;
  bottomInset: string;
  layoutEditing?: boolean;
  onRemoveFromDock?: (appId: string) => void;
  onDragStart: (event: React.PointerEvent<HTMLButtonElement>, appId: AppID) => void;
  dragAppId: AppID | null;
  dropActive?: boolean;
}

export const LauncherDock: React.FC<LauncherDockProps> = React.memo(({
  dockApps,
  totalUnread,
  openApp,
  acnh,
  paper,
  bottomInset,
  layoutEditing = false,
  onRemoveFromDock,
  onDragStart,
  dragAppId,
  dropActive = false,
}) => {
  return (
    <div className="mt-auto flex justify-center w-full px-4 relative z-30" style={{ paddingBottom: bottomInset }}>
      <div
        data-dock-drop-zone
        onClickCapture={(e) => {
          if (layoutEditing && !(e.target as HTMLElement).closest('[data-dock-action]')) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        className={`rounded-[1.75rem] px-4 py-3 flex gap-3 sm:gap-6 items-center mx-auto max-w-full justify-between overflow-x-auto no-scrollbar transform-gpu transition-all ${dropActive ? 'ring-2 ring-amber-400 scale-[1.03] bg-amber-100/60' : ''} ${acnh || paper ? '' : 'bg-white/30 border border-white/25 shadow-[0_8px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]'}`}
        style={acnh ? { background: 'transparent' } : paper ? { background: 'rgba(224,221,215,0.42)', border: '1px solid rgba(91,72,51,0.07)', boxShadow: '0 6px 18px rgba(91,72,51,0.065)' } : undefined}
      >
        {dockApps.map(app => (
          <div key={app.id} data-dock-app={app.id} className={`relative rounded-2xl transition-all ${dragAppId === app.id ? 'opacity-35 scale-95' : ''}`}>
            <AppIcon
              app={app}
              onClick={() => {
                if (!layoutEditing) openApp(app.id);
              }}
              disabled={layoutEditing}
              variant="dock"
              size="md"
            />
            {app.id === 'chat' && totalUnread > 0 && (
              <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-[9px] flex items-center justify-center border-2 border-white/20 shadow-sm font-bold pointer-events-none animate-pop-in">
                {totalUnread > 9 ? '9+' : totalUnread}
              </div>
            )}
            {layoutEditing && (
              <>
                <button
                  data-dock-action="remove-from-dock"
                  onClick={(e) => { e.stopPropagation(); onRemoveFromDock?.(app.id); }}
                  className={EDIT_DELETE_BADGE_CLASS}
                  title="从桌面移除"
                ><X size={11} weight="bold" /></button>
                <button
                  data-dock-action="select"
                  onPointerDown={event => onDragStart(event, app.id)}
                  className="absolute inset-0 z-20 rounded-2xl cursor-grab active:cursor-grabbing touch-none"
                  title={`按住拖动 ${app.displayName}`}
                  aria-label={`按住拖动 ${app.displayName}`}
                />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

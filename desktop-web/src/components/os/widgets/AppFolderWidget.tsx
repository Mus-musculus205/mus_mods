import React from 'react';
import type { PlacedItem } from '../../../registry/widgets/layout';
import { AppID, APP_REGISTRY, getDesktopAppDefinition } from '../../../apps/registry';
import { readFolderConfig } from '../../../utils/desktopFolders';
import { useAppIconArtwork } from '../AppIconArtwork';
import { ImageArtwork } from '../ImageArtwork';

const MiniAppGlyph: React.FC<{ appId: string; acnh: boolean; contentColor: string }> = ({ appId, acnh, contentColor }) => {
  const app = getDesktopAppDefinition(APP_REGISTRY, appId as AppID);
  const { customIconUrl, DefaultIcon, nookTile } = useAppIconArtwork(app, acnh);
  if (!app) return null;
  if (nookTile) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ backgroundColor: nookTile.color, borderRadius: '30%' }}>
        <div className="w-[78%] h-[78%]">{nookTile.glyph}</div>
      </div>
    );
  }
  if (customIconUrl) {
    return <ImageArtwork src={customIconUrl} className="w-full h-full rounded-[28%]" />;
  }
  return (
    <div className="w-full h-full rounded-[28%] bg-white/45 flex items-center justify-center" style={{ color: contentColor }}>
      <DefaultIcon className="w-[62%] h-[62%]" />
    </div>
  );
};

interface AppFolderWidgetProps {
  item: PlacedItem;
  iconPx?: number;
  contentColor: string;
  acnh: boolean;
  paper: boolean;
  onOpen: () => void;
}

/** 桌面上的文件夹：和 App 图标一样大，里面 3×3 排前 9 个 App 的小图标，下面是文件夹名。 */
export const AppFolderWidget: React.FC<AppFolderWidgetProps> = ({ item, iconPx, contentColor, acnh, paper, onOpen }) => {
  const { name, apps } = readFolderConfig(item);
  const labelColor = acnh ? '#725d42' : contentColor;
  const tileStyle: React.CSSProperties = {
    ...(iconPx ? { width: `${iconPx}px`, height: `${iconPx}px` } : {}),
    ...(paper
      ? { background: 'rgba(91,72,51,0.12)', border: '1px solid rgba(91,72,51,0.1)' }
      : acnh
        ? { background: 'rgba(247,243,223,0.95)', border: '2px solid rgba(232,226,214,1)' }
        : { background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.3)', boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.25)' }),
  };

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`文件夹：${name}`}
      className="flex flex-col items-center gap-1.5 active:scale-95 transition-transform duration-200"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div
        className="w-[3.5rem] h-[3.5rem] rounded-[1.125rem] grid grid-cols-3 grid-rows-3 gap-[2px] p-[5px] backdrop-blur-md"
        style={tileStyle}
      >
        {apps.slice(0, 9).map(id => (
          <MiniAppGlyph key={id} appId={id} acnh={acnh} contentColor={contentColor} />
        ))}
      </div>
      <span
        className={`text-[10px] max-w-full truncate ${paper ? 'tracking-[0.08em] font-semibold opacity-75' : 'tracking-widest font-bold opacity-80 text-shadow-md'}`}
        style={{ color: labelColor }}
      >
        {name}
      </span>
    </button>
  );
};

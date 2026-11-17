
import React from 'react';
import type { DesktopAppDefinition } from '../../apps/registry';
import type { AppConfig } from '../../types';
import { isPaperWallpaper, useOS } from '../../context/OSContext';
import { useAppIconArtwork } from './AppIconArtwork';
import { ImageArtwork } from './ImageArtwork';
import { preloadApp } from './appPreload';

interface AppIconProps {
  app: DesktopAppDefinition | AppConfig;
  onClick: () => void;
  size?: 'sm' | 'md' | 'lg';
  hideLabel?: boolean;
  variant?: 'default' | 'minimal' | 'dock';
  disabled?: boolean;
  /** 自由网格桌面传入实际 cell 尺寸，避免图标永远固定在 56px。 */
  iconPx?: number;
}

const appDisplayName = (app: DesktopAppDefinition | AppConfig) => 'displayName' in app ? app.displayName : app.name;
const appIconKey = (app: DesktopAppDefinition | AppConfig) => 'iconKey' in app ? app.iconKey : app.icon;

const AppIcon: React.FC<AppIconProps> = React.memo(({ app, onClick, size = 'md', hideLabel = false, variant = 'default', disabled = false, iconPx }) => {
  const { theme } = useOS();
  const displayName = appDisplayName(app);
  const isNook = theme.skin === 'animalcrossing';
  const { customIconUrl, DefaultIcon, nookTile } = useAppIconArtwork(app, isNook);
  const isPaperDesktop = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  const preserveCustomOutline = !!customIconUrl && theme.preserveCustomIconOutlines === true;
  // 动森皮肤下标签用深棕色，普通皮肤沿用主题 contentColor。
  const contentColor = isNook ? '#725d42' : (theme.contentColor || '#ffffff');
  const iconSizeStyle = iconPx ? { width: `${iconPx}px`, height: `${iconPx}px` } : undefined;
  const buttonClassName = 'flex flex-col items-center gap-1.5 group relative active:scale-95 transition-transform duration-200';

  const handleClick = (e: React.MouseEvent) => {
    if (disabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick();
  };

  // Standard sizes
  const sizeClasses =
    size === 'lg' ? 'w-[4.25rem] h-[4.25rem]' :
    size === 'sm' ? 'w-[2.75rem] h-[2.75rem]' :
    'w-[3.5rem] h-[3.5rem]';

  // 动森彩蛋模式：整机统一 NookPhone 外观，连用户自定义图标也一并盖掉。
  if (nookTile) {
    return (
      <button
        onClick={handleClick}
        aria-disabled={disabled}
        onPointerDown={() => preloadApp(app.id)}
        className={buttonClassName}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {/* NookPhone 圆角方块瓦片：纯平面，无边框/无阴影/无高光（对齐参考图） */}
        <div
          className={`${sizeClasses} relative flex items-center justify-center overflow-hidden`}
          style={{ ...iconSizeStyle, backgroundColor: nookTile.color, borderRadius: '34%' }}
        >
          <div className="w-[78%] h-[78%] relative">
            {nookTile.glyph}
          </div>
        </div>
        {!hideLabel && (
          <span
            className={`${size === 'sm' ? 'text-[9px] tracking-wide' : 'text-[10.5px] tracking-wide'} font-bold max-w-full truncate ${variant === 'dock' ? 'hidden' : 'block'}`}
            style={{ color: contentColor }}
          >
            {displayName}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      aria-disabled={disabled}
      onPointerDown={() => preloadApp(app.id)}
      className={buttonClassName}
      style={{ WebkitTapHighlightColor: 'transparent', WebkitTouchCallout: 'none' } as React.CSSProperties}
    >
      {/* #409 的“保留透明图标原轮廓”改为可选；默认继续使用原来的系统圆角底框。 */}
      <div
        className={`${sizeClasses} relative flex items-center justify-center ${preserveCustomOutline ? '' : isPaperDesktop ? `
          rounded-[1.1rem] border
          transition-[transform,background-color,box-shadow] duration-200
          group-hover:-translate-y-0.5
        ` : `
        bg-white/40 rounded-[1.125rem]
        border border-white/35
        shadow-[0_4px_12px_rgba(0,0,0,0.16)]
        group-hover:bg-white/50 group-hover:border-white/50
      `}`}
        style={!preserveCustomOutline && isPaperDesktop ? {
          ...iconSizeStyle,
          background: 'rgba(224,221,215,0.42)',
          borderColor: 'rgba(91,72,51,0.075)',
          boxShadow: '0 4px 12px rgba(91,72,51,0.055)',
        } : iconSizeStyle}
      >

        {customIconUrl ? (
            <ImageArtwork
              src={customIconUrl}
              fit={preserveCustomOutline ? 'contain' : 'cover'}
              className={`w-full h-full ${preserveCustomOutline ? '' : 'rounded-[1.2rem]'}`}
              alt={`${displayName} 自定义图标`}
            />
        ) : (
            <div
                className={isPaperDesktop
                  ? 'w-[47%] h-[47%] opacity-80'
                  : 'w-[50%] h-[50%] drop-shadow-[0_2px_5px_rgba(0,0,0,0.3)] opacity-90'}
                style={{ color: contentColor }}
            >
                 <DefaultIcon className="w-full h-full" />
            </div>
        )}
      </div>

      {!hideLabel && (
        <span
            className={`${size === 'sm' ? 'text-[8.5px]' : 'text-[10px]'} ${isPaperDesktop ? 'tracking-[0.08em] font-semibold opacity-75' : 'tracking-widest font-bold uppercase opacity-80 text-shadow-md'} transition-opacity max-w-full truncate ${variant === 'dock' ? 'hidden' : 'block'}`}
            style={{ color: contentColor }}
        >
          {displayName}
        </span>
      )}
    </button>
  );
}, (prev, next) => {
    // Custom comparison to prevent re-render unless specific props change
    return prev.app.id === next.app.id &&
           appDisplayName(prev.app) === appDisplayName(next.app) &&
           appIconKey(prev.app) === appIconKey(next.app) &&
           prev.size === next.size &&
           prev.hideLabel === next.hideLabel &&
           prev.variant === next.variant &&
           prev.disabled === next.disabled &&
           prev.iconPx === next.iconPx;
});

export default AppIcon;

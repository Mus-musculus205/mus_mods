import React from 'react';
import { useIsDesktopMode } from '../../../hooks/useDeviceMode';

interface PageIndicatorsProps {
  totalPages: number;
  activePageIndex: number;
  contentColor: string;
  bottomInset: string;
  onJumpToPage?: (index: number) => void;
}

// 移动端保持原本纤细无交互的点状条；电脑模式（见 useIsDesktopMode）静默升级成
// 悬浮毛玻璃胶囊，放大点位与点击热区，点击任意点平滑跳页。
export const PageIndicators: React.FC<PageIndicatorsProps> = React.memo(({
  totalPages,
  activePageIndex,
  contentColor,
  bottomInset,
  onJumpToPage,
}) => {
  const isDesktop = useIsDesktopMode();

  return (
    <div
      className={`absolute left-0 w-full flex justify-center z-20 ${isDesktop ? 'pointer-events-none' : 'gap-1 pointer-events-none'}`}
      style={{ bottom: `calc(${bottomInset} + 5.5rem)` }}
      aria-hidden={!isDesktop}
    >
      <div
        className={isDesktop
          ? 'flex items-center gap-0.5 rounded-full border border-white/20 bg-black/10 px-3.5 py-1.5 shadow-sm backdrop-blur-md pointer-events-auto dark:bg-white/10'
          : 'flex items-center gap-1'}
      >
        {Array.from({ length: totalPages }).map((_, i) => (
          <button
            key={i}
            type="button"
            tabIndex={isDesktop ? 0 : -1}
            aria-label={isDesktop ? `跳转到第 ${i + 1} 页` : undefined}
            onClick={isDesktop ? (e) => { e.stopPropagation(); onJumpToPage?.(i); } : undefined}
            className={`group flex shrink-0 items-center justify-center ${isDesktop ? 'h-6 w-6 cursor-pointer' : 'h-1.5 w-4'}`}
          >
            <span
              className={`rounded-full transform-gpu transition-[width,opacity,transform] duration-300 ${
                isDesktop
                  ? `h-2.5 group-hover:scale-125 ${activePageIndex === i ? 'w-7 opacity-100' : 'w-2.5 opacity-50 group-hover:opacity-80'}`
                  : `h-1.5 ${activePageIndex === i ? 'w-4 opacity-100' : 'w-1.5 opacity-40'}`
              }`}
              style={{ backgroundColor: contentColor }}
            />
          </button>
        ))}
      </div>
    </div>
  );
});

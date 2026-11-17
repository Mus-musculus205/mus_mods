import React from 'react';
import { isPaperWallpaper, useOS } from '../../../context/OSContext';
import { useBlobRefUrl } from '../../../utils/blobRef';
import { ImageArtwork } from '../ImageArtwork';

/**
 * 桌面相框小组件。原本内联在 apps/Launcher.tsx（DesktopSquareImage），
 * 自由网格版：图片走 item.config.src（每个实例独立）。
 */
export const DesktopImageWidget = React.memo(({ image, contentColor, onClick, acnh = false }: {
    image?: string,
    contentColor: string,
    onClick: () => void,
    acnh?: boolean,
}) => {
    const { theme } = useOS();
    const imageUrl = useBlobRefUrl(image);
    const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
    const surfaceStyle = paper ? {
        background: image ? 'rgba(224,221,215,0.26)' : 'rgba(224,221,215,0.38)',
        border: '1px solid rgba(91,72,51,0.07)',
        boxShadow: '0 5px 16px rgba(91,72,51,0.055)',
    } : acnh ? {
        background: 'rgb(247,243,223)',
        border: '2px solid #e8e2d6',
        boxShadow: '0 6px 18px rgba(61,52,40,0.12)',
    } : {
        background: image ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.28)',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow: '0 8px 30px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07)',
    };
    return (
        <button
            type="button"
            aria-label={image ? '更换图片' : '添加图片'}
            onClick={onClick}
            className="relative block w-full h-full rounded-[1.75rem] overflow-hidden cursor-pointer animate-fade-in transition-transform active:scale-[0.98]"
            style={{ ...surfaceStyle, color: contentColor, WebkitTouchCallout: 'none' } as React.CSSProperties}
        >
            {imageUrl && <ImageArtwork src={imageUrl} className="absolute inset-0" />}
            {!image && (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
                    <span className="w-9 h-9 rounded-full flex items-center justify-center"
                        style={{ background: paper ? 'rgba(120,131,105,0.10)' : 'rgba(255,255,255,0.1)', border: paper ? '1px solid rgba(91,72,51,0.12)' : '1px solid rgba(255,255,255,0.16)' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="w-4 h-4 opacity-70">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                        </svg>
                    </span>
                    <span className="text-[8.5px] uppercase font-bold tracking-[0.22em] opacity-55">Add Image</span>
                    <span className="text-[8.5px] opacity-40 leading-tight">点一下换图</span>
                </span>
            )}
        </button>
    );
});

export default DesktopImageWidget;

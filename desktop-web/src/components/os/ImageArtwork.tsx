interface ImageArtworkProps {
  src: string;
  className: string;
  alt?: string;
  fit?: 'cover' | 'contain';
}

// 用背景渲染图案，长按由外层按钮接收，避免触屏浏览器打开原生图片菜单。
export function ImageArtwork({ src, className, alt, fit = 'cover' }: ImageArtworkProps) {
  return (
    <span
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      className={`block ${className}`}
      style={{
        backgroundImage: `url(${JSON.stringify(src)})`,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundSize: fit,
        pointerEvents: 'none',
      }}
    />
  );
}

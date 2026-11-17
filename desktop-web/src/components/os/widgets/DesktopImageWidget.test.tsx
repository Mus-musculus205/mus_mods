// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DesktopImageWidget } from './DesktopImageWidget';

vi.mock('../../../context/OSContext', () => ({
  isPaperWallpaper: () => false,
  useOS: () => ({ theme: {} }),
}));

it('calls the photo action on click and forwards pointerdown to the grid', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const onClick = vi.fn();
  const onPointerDown = vi.fn();
  const image = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E';

  try {
    act(() => root.render(
      <div onPointerDown={onPointerDown}>
        <DesktopImageWidget image={image} contentColor="#fff" onClick={onClick} />
      </div>,
    ));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="更换图片"]')!;
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('span')?.style.backgroundImage).toContain(image);

    act(() => { button.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
    act(() => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

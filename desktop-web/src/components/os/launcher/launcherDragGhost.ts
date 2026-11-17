interface DragGhostOptions {
  className?: string;
  hitTestAttribute?: string;
  style?: Partial<CSSStyleDeclaration>;
}

export function createDragGhost(source: HTMLElement, { className, hitTestAttribute, style }: DragGhostOptions) {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  if (className) ghost.classList.add(className);
  if (hitTestAttribute) ghost.removeAttribute(hitTestAttribute);
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '9999',
    transition: 'none',
    ...style,
  });
  source.ownerDocument.body.appendChild(ghost);
  return { ghost, rect };
}

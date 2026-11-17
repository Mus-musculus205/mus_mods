// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useIsDesktopMode } from '../hooks/useDeviceMode';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MqlListener = (e: { matches: boolean }) => void;

interface MockMql {
  matches: boolean;
  media: string;
  onchange: null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  setMatches: (nextMatches: boolean) => void;
}

function createMockMediaQueryList(initialMatches: boolean): MockMql {
  const listeners = new Set<MqlListener>();
  const mql: MockMql = {
    matches: initialMatches,
    media: '(pointer: fine) and (hover: hover)',
    onchange: null,
    addListener: vi.fn((fn: MqlListener) => {
      listeners.add(fn);
    }),
    removeListener: vi.fn((fn: MqlListener) => {
      listeners.delete(fn);
    }),
    addEventListener: vi.fn((event: string, fn: MqlListener) => {
      if (event === 'change') {
        listeners.add(fn);
      }
    }),
    removeEventListener: vi.fn((event: string, fn: MqlListener) => {
      if (event === 'change') {
        listeners.delete(fn);
      }
    }),
    dispatchEvent: vi.fn(),
    setMatches(nextMatches: boolean) {
      mql.matches = nextMatches;
      listeners.forEach((listener) => listener({ matches: nextMatches }));
    },
  };
  return mql;
}

const CapabilityConsumer: React.FC<{ onRender?: (isDesktop: boolean) => void }> = ({ onRender }) => {
  const isDesktop = useIsDesktopMode();
  useEffect(() => {
    onRender?.(isDesktop);
  }, [isDesktop, onRender]);
  return React.createElement('div', { 'data-testid': 'consumer', 'data-is-desktop': isDesktop });
};

describe('useIsDesktopMode capability hook', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    document.documentElement.className = '';
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.documentElement.className = '';
    vi.clearAllMocks();
  });

  it('正确响应 media query 的 matches 初始状态与动态切换', async () => {
    const mockMql = createMockMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mockMql);

    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    let observedDesktop: boolean | null = null;
    await React.act(async () => {
      root.render(React.createElement(CapabilityConsumer, {
        onRender: (val) => { observedDesktop = val; },
      }));
    });

    expect(observedDesktop).toBe(true);

    // 模拟从桌面鼠标环境切换到触控无 hover 环境
    await React.act(async () => {
      mockMql.setMatches(false);
    });
    expect(observedDesktop).toBe(false);

    // 再次切回桌面环境
    await React.act(async () => {
      mockMql.setMatches(true);
    });
    expect(observedDesktop).toBe(true);

    await React.act(async () => {
      root.unmount();
    });
    rootEl.remove();
  });

  it('支持无 addEventListener 的旧版环境回退到 addListener / removeListener', async () => {
    const listeners = new Set<MqlListener>();
    const legacyMql = {
      matches: false,
      media: '(pointer: fine) and (hover: hover)',
      addListener: vi.fn((fn: MqlListener) => listeners.add(fn)),
      removeListener: vi.fn((fn: MqlListener) => listeners.delete(fn)),
    };
    window.matchMedia = vi.fn().mockReturnValue(legacyMql);

    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    let observedDesktop: boolean | null = null;
    await React.act(async () => {
      root.render(React.createElement(CapabilityConsumer, {
        onRender: (val) => { observedDesktop = val; },
      }));
    });

    expect(observedDesktop).toBe(false);
    expect(legacyMql.addListener).toHaveBeenCalledTimes(1);

    await React.act(async () => {
      legacyMql.matches = true;
      listeners.forEach((listener) => listener({ matches: true }));
    });
    expect(observedDesktop).toBe(true);

    await React.act(async () => {
      root.unmount();
    });
    expect(legacyMql.removeListener).toHaveBeenCalledTimes(1);
    rootEl.remove();
  });

  it('子组件调用 useIsDesktopMode 时，mount 与 unmount 均不操作 html.is-desktop class', async () => {
    const mockMql = createMockMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mockMql);

    // 初始状态：html 节点无 is-desktop 类名
    expect(document.documentElement.classList.contains('is-desktop')).toBe(false);

    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const root = createRoot(rootEl);

    // 1. 子组件在 desktop = true 下 mount
    await React.act(async () => {
      root.render(React.createElement(CapabilityConsumer));
    });

    // 验证：虽然 capability 为 true，但作为纯 hook 不得向 documentElement 添加 class
    expect(document.documentElement.classList.contains('is-desktop')).toBe(false);

    // 2. 子组件 unmount
    await React.act(async () => {
      root.unmount();
    });

    // 验证：unmount 后 html class 仍未被变动
    expect(document.documentElement.classList.contains('is-desktop')).toBe(false);

    // 3. 假设根层（如 App.tsx）设置了 is-desktop 类名
    document.documentElement.classList.add('is-desktop');
    expect(document.documentElement.classList.contains('is-desktop')).toBe(true);

    // 此时挂载一个运行在 non-desktop 模式下的子组件
    mockMql.matches = false;
    const secondRootEl = document.createElement('div');
    document.body.appendChild(secondRootEl);
    const secondRoot = createRoot(secondRootEl);

    await React.act(async () => {
      secondRoot.render(React.createElement(CapabilityConsumer));
    });

    // 验证：非 desktop 子组件 mount 绝不会错误移除根层的 is-desktop 类名
    expect(document.documentElement.classList.contains('is-desktop')).toBe(true);

    // 子组件 unmount 也绝不影响根层持有的类名
    await React.act(async () => {
      secondRoot.unmount();
    });
    expect(document.documentElement.classList.contains('is-desktop')).toBe(true);

    rootEl.remove();
    secondRootEl.remove();
  });
});

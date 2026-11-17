// @vitest-environment jsdom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(), apk: vi.fn(), web: vi.fn(), install: vi.fn(), start: vi.fn(), stop: vi.fn(),
}));
vi.mock('./androidAppUpdate', () => ({
  isAndroidAppUpdateEnabled: () => true, clearVersionCooldown: vi.fn(),
  downloadAndVerifyAndroidUpdate: mocks.apk, installVerifiedAndroidUpdate: mocks.install,
  startUpdateDownloadService: mocks.start, stopUpdateDownloadService: mocks.stop,
  openAppDetailsSettings: vi.fn(), requestInstallPermission: vi.fn(),
}));
vi.mock('./webUpdate', () => ({
  isWebUpdateEnabled: () => true, getCurrentBundle: async () => ({ bundleId: null }),
  downloadAndApplyWebUpdate: mocks.web, reloadWebRuntime: vi.fn(), resetWebBundle: vi.fn(),
}));
vi.mock('./appUpdateCheck', () => ({ checkForAppUpdates: mocks.check, startAppUpdateCheckOnce: mocks.check }));
import AndroidUpdateControl from '../components/settings/AndroidUpdateControl';
import { checkAppUpdateSession, getAppUpdateSession } from './appUpdateSession';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.install.mockResolvedValue({ status: 'installer_opened' });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Settings real React lifecycle with mocked native IO', () => {
  it.each(['apk', 'web'] as const)('reconnects %s download after closing Settings and keeps completion actionable', async kind => {
    mocks.check.mockResolvedValueOnce({
      installed: { versionCode: 100 },
      strategy: kind === 'apk'
        ? { action: 'APK_UPDATE', reason: 'available', apkManifest: { versionCode: 200, versionName: 'next' } }
        : { action: 'WEB_UPDATE', reason: 'available', webManifest: { bundleId: 'next', buildNumber: 200 } },
    });
    await checkAppUpdateSession();
    let onProgress!: (progress: number) => void;
    let finish!: (path?: string) => void;
    const transfer = new Promise<string | undefined>(resolve => { finish = resolve; });
    const downloadMock = kind === 'apk' ? mocks.apk : mocks.web;
    downloadMock.mockImplementationOnce((_target, progress) => { onProgress = progress; return transfer; });
    await act(async () => root.render(React.createElement(AndroidUpdateControl)));
    await act(async () => container.querySelector('button')!.click());
    await act(async () => onProgress(0.4));
    expect(container.textContent).toContain('40%');
    await act(async () => root.unmount());
    onProgress(0.7);
    root = createRoot(container);
    await act(async () => root.render(React.createElement(AndroidUpdateControl)));
    expect(container.textContent).toContain('70%');
    expect(downloadMock).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => finish(kind === 'apk' ? 'file:///verified.apk' : undefined));
    await vi.waitFor(() => expect(getAppUpdateSession().phase).toBe(kind === 'apk' ? 'apk_ready' : 'web_ready'));
    expect(container.textContent).toContain(kind === 'apk' ? '继续安装' : '点击立即生效');
    expect(mocks.install).not.toHaveBeenCalled();
    if (kind === 'apk') {
      await act(async () => container.querySelector('button')!.click());
      expect(mocks.install).toHaveBeenCalledWith('file:///verified.apk', expect.objectContaining({ versionCode: 200 }));
      expect(container.textContent).toContain('继续安装');
      expect(downloadMock).toHaveBeenCalledOnce();
    }
  });
});

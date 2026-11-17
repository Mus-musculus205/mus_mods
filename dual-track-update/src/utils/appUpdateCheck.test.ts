import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetStartupAppUpdateCheckForTest,
  startAppUpdateCheckOnce,
} from './appUpdateCheck';

const mocks = vi.hoisted(() => ({
  isEnabled: true,
  getInstalled: vi.fn().mockResolvedValue({ versionCode: 100, versionName: '1.0', runtimeId: 1 }),
  fetchApk: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    versionCode: 100,
    versionName: '1.0',
    apkUrl: 'https://example.com/app.apk',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
  }),
  fetchWeb: vi.fn().mockResolvedValue(null),
  getNext: vi.fn().mockResolvedValue({ bundleId: null }),
}));

vi.mock('./androidAppUpdate', () => ({
  fetchAndroidUpdateManifest: mocks.fetchApk,
  getInstalledAndroidAppInfo: mocks.getInstalled,
  isAndroidAppUpdateEnabled: () => mocks.isEnabled,
  isVersionInCooldown: () => false,
}));

vi.mock('./webUpdate', () => ({
  fetchWebUpdateManifest: mocks.fetchWeb,
  getNextBundle: mocks.getNext,
  isWebUpdateEnabled: () => false,
}));

describe('启动应用更新检查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isEnabled = true;
    resetStartupAppUpdateCheckForTest();
  });

  it('同一进程生命周期并发调用只执行一次并复用结果', async () => {
    const first = startAppUpdateCheckOnce();
    const second = startAppUpdateCheckOnce();
    expect(first).toBe(second);
    const result = await first;
    expect(result.strategy.action).toBe('LATEST');
    expect(mocks.getInstalled).toHaveBeenCalledTimes(1);
    expect(mocks.fetchApk).toHaveBeenCalledTimes(1);
  });

  it('未启用更新的平台不会触碰原生插件', async () => {
    mocks.isEnabled = false;
    await expect(startAppUpdateCheckOnce()).rejects.toThrow(/未启用应用更新检查/);
    expect(mocks.getInstalled).not.toHaveBeenCalled();
  });
});

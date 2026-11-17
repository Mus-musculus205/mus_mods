import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { installerMocks } = vi.hoisted(() => ({
  installerMocks: {
    getInstalledInfo: vi.fn(),
    downloadApk: vi.fn(),
    cancelApkDownload: vi.fn(),
    addListener: vi.fn(),
    verifyApk: vi.fn(),
    installApk: vi.fn(),
    openInstallPermissionSettings: vi.fn(),
  },
}));

const httpMock = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  },
  CapacitorHttp: {
    request: (...args: unknown[]) => httpMock(...args),
  },
  registerPlugin: () => installerMocks,
}));

import {
  clearVersionCooldown,
  getFailedUpdateRecord,
  recordVersionVerificationFailure,
  downloadAndVerifyAndroidUpdate,
  fetchAndroidUpdateManifest,
  installVerifiedAndroidUpdate,
  isVersionInCooldown,
  parseAndroidUpdateManifest,
} from './androidAppUpdate';

const rawValidManifest = {
  schemaVersion: 1,
  versionCode: 30402,
  versionName: '3.4.2',
  apkUrl: 'https://github.com/example/app/releases/download/v3.4.2/app.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 37_000_000,
  releaseNotes: ['修复更新按钮', '', 123],
};
const validManifest = parseAndroidUpdateManifest(rawValidManifest);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.resetAllMocks();
  clearVersionCooldown();
  installerMocks.downloadApk.mockResolvedValue({ path: 'file:///cache/updates/SullyOS-update.apk' });
  installerMocks.cancelApkDownload.mockResolvedValue(undefined);
  installerMocks.addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
  installerMocks.verifyApk.mockResolvedValue({
    valid: true,
    packageName: 'com.example.sullyos',
    versionCode: validManifest.versionCode,
    versionName: validManifest.versionName,
    certificateSha256: 'b'.repeat(64),
    canRequestPackageInstalls: true,
  });
});

it('passes the complete manifest on every installer invocation, including permission resume', async () => {
  installerMocks.installApk.mockResolvedValueOnce({ status: 'permission_required' }).mockResolvedValueOnce({ status: 'installer_opened' });
  const path = 'file:///cache/updates/SullyOS-update.apk';
  expect((await installVerifiedAndroidUpdate(path, validManifest)).status).toBe('permission_required');
  expect((await installVerifiedAndroidUpdate(path, validManifest)).status).toBe('installer_opened');
  for (const [options] of installerMocks.installApk.mock.calls) expect(options).toEqual({
    path, sha256: validManifest.sha256, sizeBytes: validManifest.sizeBytes, versionCode: validManifest.versionCode,
  });
});

describe('parseAndroidUpdateManifest', () => {
  it('accepts and normalizes a valid manifest', () => {
    expect(parseAndroidUpdateManifest(rawValidManifest)).toMatchObject({
      versionCode: 30402,
      versionName: '3.4.2',
      sha256: 'a'.repeat(64),
      releaseNotes: ['修复更新按钮'],
    });
  });

  it.each([
    ['bad schema', { ...rawValidManifest, schemaVersion: 2 }],
    ['bad version', { ...rawValidManifest, versionCode: 0 }],
    ['insecure url', { ...rawValidManifest, apkUrl: 'http://example.com/app.apk' }],
    ['bad digest', { ...rawValidManifest, sha256: 'nope' }],
    ['bad size', { ...rawValidManifest, sizeBytes: -1 }],
  ])('rejects %s', (_name, manifest) => {
    expect(() => parseAndroidUpdateManifest(manifest)).toThrow();
  });
});

describe('downloadAndVerifyAndroidUpdate', () => {
  it('uses the cancellable native transfer and verifies the manifest identity', async () => {
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).resolves.toBe(
      'file:///cache/updates/SullyOS-update.apk',
    );
    expect(installerMocks.downloadApk).toHaveBeenCalledWith({
      taskId: expect.any(String), url: validManifest.apkUrl,
    });
    expect(installerMocks.verifyApk).toHaveBeenCalledWith({
      path: 'file:///cache/updates/SullyOS-update.apk',
      sha256: validManifest.sha256,
      sizeBytes: validManifest.sizeBytes,
      versionCode: validManifest.versionCode,
    });
  });

  it('records verification failure in cooldown and clears it on success', async () => {
    installerMocks.verifyApk.mockResolvedValueOnce({ valid: false });
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).rejects.toThrow();
    expect(isVersionInCooldown(validManifest.versionCode)).toBe(true);
    await downloadAndVerifyAndroidUpdate(validManifest);
    expect(isVersionInCooldown(validManifest.versionCode)).toBe(false);
  });

  it('routes progress by taskId and removes the listener', async () => {
    let listener: (event: any) => void = () => {};
    const remove = vi.fn().mockResolvedValue(undefined);
    installerMocks.addListener.mockImplementationOnce(async (_event, callback) => {
      listener = callback;
      return { remove };
    });
    installerMocks.downloadApk.mockImplementationOnce(async () => {
      listener({ taskId: 'unrelated', bytes: 90, contentLength: 100 });
      listener({ taskId: 'progress-test', bytes: 25, contentLength: 100 });
      return { path: 'file:///cache/updates/SullyOS-update.apk' };
    });
    const progress = vi.fn();
    await downloadAndVerifyAndroidUpdate(validManifest, progress, { taskId: 'progress-test' });
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0.25, 1]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not release the shared destination until cancelled native IO settles', async () => {
    let rejectTransfer!: (error: Error) => void;
    installerMocks.downloadApk.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectTransfer = reject;
    }));
    const controller = new AbortController();
    const pending = downloadAndVerifyAndroidUpdate(validManifest, undefined, {
      taskId: 'cancel-test', signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(installerMocks.cancelApkDownload).toHaveBeenCalledWith({ taskId: 'cancel-test' });
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).rejects.toThrow('已有 APK');
    rejectTransfer(new Error('Socket closed'));
    await rejected;
    expect(isVersionInCooldown(validManifest.versionCode)).toBe(false);
    expect(installerMocks.verifyApk).not.toHaveBeenCalled();
    await downloadAndVerifyAndroidUpdate(validManifest);
    expect(installerMocks.downloadApk).toHaveBeenCalledTimes(2);
  });

  it('cancels during verification without marking the build as failed', async () => {
    const controller = new AbortController();
    installerMocks.verifyApk.mockImplementationOnce(async () => {
      controller.abort();
      return { valid: true, versionCode: validManifest.versionCode };
    });
    await expect(downloadAndVerifyAndroidUpdate(validManifest, undefined, {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(isVersionInCooldown(validManifest.versionCode)).toBe(false);
  });

  it('waits for a failed transfer before starting its retry', async () => {
    vi.useFakeTimers();
    try {
      installerMocks.downloadApk.mockRejectedValueOnce(new Error('Read timed out'));
      const pending = downloadAndVerifyAndroidUpdate(validManifest);
      await vi.advanceTimersByTimeAsync(999);
      expect(installerMocks.downloadApk).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(installerMocks.downloadApk).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('cancels retry backoff without starting another transfer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      installerMocks.downloadApk.mockRejectedValueOnce(new Error('Disconnected'));
      const pending = downloadAndVerifyAndroidUpdate(validManifest, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await rejected;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(installerMocks.downloadApk).toHaveBeenCalledTimes(1);
      expect(isVersionInCooldown(validManifest.versionCode)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  describe('fetchAndroidUpdateManifest', () => {
    beforeEach(() => {
      import.meta.env.VITE_APK_UPDATE_MANIFEST_URL = 'https://example.com/update-manifest.json';
    });

    it('uses CapacitorHttp on native platforms to bypass CORS', async () => {
      httpMock.mockResolvedValueOnce({
        status: 200,
        data: validManifest,
      });

      const manifest = await fetchAndroidUpdateManifest();
      expect(manifest.versionCode).toBe(validManifest.versionCode);
      expect(manifest.sha256).toBe(validManifest.sha256);
      expect(httpMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
      );
    });

    it('throws when HTTP status is error', async () => {
      httpMock.mockResolvedValueOnce({
        status: 404,
        data: 'Not Found',
      });

      await expect(fetchAndroidUpdateManifest()).rejects.toThrow('检查更新失败（HTTP 404）');
    });

  });
});

describe('optional local update cooldown journal', () => {
  const key = 'os_failed_android_update_record';
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); },
      removeItem: (name: string) => { values.delete(name); },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  it('overwrites one journal through 8192 failures and clears it without leaving a parallel history', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const reason = 'x'.repeat(8192);
    for (let index = 1; index <= 8192; index++) {
      recordVersionVerificationFailure(index, reason);
      expect(getFailedUpdateRecord()?.versionCode).toBe(index);
    }
    expect(values.size).toBe(1);
    expect(getFailedUpdateRecord()).toEqual({ versionCode: 8192, failedAt: 1_800_000_000_000, reason: 'x'.repeat(1024) });
    expect(values.get(key)!.length).toBeLessThan(1200);
    expect(isVersionInCooldown(8192)).toBe(true); expect(isVersionInCooldown(8191)).toBe(false);
    clearVersionCooldown(); expect(values.size).toBe(0); expect(getFailedUpdateRecord()).toBeNull();
  });
  it.each(['{bad json', '', 'null', '[]', '{}', '{"versionCode":"1","failedAt":123,"reason":"x"}', '{"versionCode":1,"failedAt":-1,"reason":"x"}', '{"versionCode":1,"failedAt":123,"reason":{}}'])('diagnoses malformed journal %s without deleting or rewriting it', raw => {
    values.set(key, raw);
    expect(getFailedUpdateRecord()).toBeNull();
    expect(values.get(key)).toBe(raw);
    expect(console.warn).toHaveBeenCalledWith('[AndroidUpdate] Optional cooldown journal failed', expect.objectContaining({ operation: 'read', key }));
  });
  it('handles cooldown boundary, future clock and version mismatch explicitly', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    recordVersionVerificationFailure(7, 'failure');
    vi.mocked(Date.now).mockReturnValue(1_800_000_000_000 - 1); expect(isVersionInCooldown(7)).toBe(false);
    vi.mocked(Date.now).mockReturnValue(1_800_000_000_000 + 86_400_000 - 1); expect(isVersionInCooldown(7)).toBe(true);
    vi.mocked(Date.now).mockReturnValue(1_800_000_000_000 + 86_400_000); expect(isVersionInCooldown(7)).toBe(false);
    expect(isVersionInCooldown(8)).toBe(false);
  });
  it('diagnoses denied reads and never claims a cooldown from unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('denied', 'SecurityError'); } });
    expect(isVersionInCooldown(validManifest.versionCode)).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[AndroidUpdate] Optional cooldown journal failed', expect.objectContaining({ operation: 'read', key }));
  });
  it('retains the last good journal on quota failure while preserving the real verification error and recovery', async () => {
    recordVersionVerificationFailure(99, 'previous'); const previous = values.get(key);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    installerMocks.verifyApk.mockResolvedValueOnce({ valid: false });
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).rejects.toThrow('下载的 APK 与更新清单版本不一致');
    expect(values.get(key)).toBe(previous);
    expect(console.warn).toHaveBeenCalledWith('[AndroidUpdate] Optional cooldown journal failed', expect.objectContaining({ operation: 'write', key }));
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).resolves.toBe('file:///cache/updates/SullyOS-update.apk');
    expect(values.size).toBe(0);
  });
  it('reports clear denial but does not turn a verified download into failure', async () => {
    recordVersionVerificationFailure(validManifest.versionCode, 'old failure');
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).resolves.toBe('file:///cache/updates/SullyOS-update.apk');
    expect(getFailedUpdateRecord()?.versionCode).toBe(validManifest.versionCode);
    expect(console.warn).toHaveBeenCalledWith('[AndroidUpdate] Optional cooldown journal failed', expect.objectContaining({ operation: 'clear', key }));
  });
  it('rejects invalid writer versions before mutating the previous journal', () => {
    recordVersionVerificationFailure(7, 'old'); const previous = values.get(key);
    for (const version of [0, -1, NaN, Infinity, 1.5]) expect(() => recordVersionVerificationFailure(version, 'bad')).toThrow('Invalid cooldown versionCode');
    expect(values.get(key)).toBe(previous);
  });
});

describe('APK update runtime contention pressure (native IO mocked)', () => {
  it('rejects 64 competing shared-destination requests until the reserved transfer settles, then permits retry', async () => {
    let finish!: (value: { path: string }) => void;
    installerMocks.downloadApk.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reserved = downloadAndVerifyAndroidUpdate(validManifest);
    const contenders = await Promise.allSettled(Array.from({ length: 64 }, () => downloadAndVerifyAndroidUpdate(validManifest)));
    expect(contenders.every(result => result.status === 'rejected' && result.reason.message === '已有 APK 下载任务正在运行')).toBe(true);
    expect(getFailedUpdateRecord()).toBeNull();
    expect(installerMocks.verifyApk).not.toHaveBeenCalled();
    finish({ path: 'file:///cache/updates/SullyOS-update.apk' });
    await expect(reserved).resolves.toBe('file:///cache/updates/SullyOS-update.apk');
    await expect(downloadAndVerifyAndroidUpdate(validManifest)).resolves.toBe('file:///cache/updates/SullyOS-update.apk');
    expect(getFailedUpdateRecord()).toBeNull();
    expect(installerMocks.downloadApk).toHaveBeenCalledTimes(2);
  });
});

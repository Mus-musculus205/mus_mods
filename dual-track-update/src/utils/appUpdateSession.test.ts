import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(), startup: vi.fn(), apk: vi.fn(), web: vi.fn(), install: vi.fn(),
  start: vi.fn(), stop: vi.fn(), clear: vi.fn(), reload: vi.fn(), reset: vi.fn(),
}));
vi.mock('./androidAppUpdate', () => ({
  clearVersionCooldown: mocks.clear, downloadAndVerifyAndroidUpdate: mocks.apk,
  installVerifiedAndroidUpdate: mocks.install, startUpdateDownloadService: mocks.start,
  stopUpdateDownloadService: mocks.stop,
}));
vi.mock('./webUpdate', () => ({
  downloadAndApplyWebUpdate: mocks.web, reloadWebRuntime: mocks.reload, resetWebBundle: mocks.reset,
}));
vi.mock('./appUpdateCheck', () => ({ checkForAppUpdates: mocks.check, startAppUpdateCheckOnce: mocks.startup }));

const apkManifest = { versionCode: 200, versionName: 'next', sha256: 'a'.repeat(64) };
const webManifest = { bundleId: 'web-next', buildNumber: 200 };
const result = (action = 'APK_UPDATE') => ({
  installed: { versionCode: 100, versionName: 'current' },
  strategy: { action, reason: 'available', ...(action === 'APK_UPDATE'
    ? { apkManifest } : { webManifest }) },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
let session: typeof import('./appUpdateSession');
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.startup.mockResolvedValue(result());
  mocks.check.mockResolvedValue(result());
  mocks.start.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.apk.mockResolvedValue('file:///verified.apk');
  mocks.web.mockResolvedValue(undefined);
  mocks.install.mockResolvedValue({ status: 'installer_opened' });
  session = await import('./appUpdateSession');
});

describe('application-owned update session', () => {
  it('retains APK progress and ready path after all Settings subscribers leave', async () => {
    await session.ensureAppUpdateSession();
    const transfer = deferred<string>();
    let progress!: (fraction: number) => void;
    mocks.apk.mockImplementationOnce((_target, onProgress) => {
      progress = onProgress;
      return transfer.promise;
    });
    const firstSubscriber = vi.fn();
    const unsubscribe = session.subscribeAppUpdateSession(firstSubscriber);
    const download = session.downloadAppUpdate();
    await vi.waitFor(() => expect(mocks.apk).toHaveBeenCalledOnce());
    progress(0.42);
    unsubscribe();
    progress(0.68);
    const reconnect = session.ensureAppUpdateSession();
    expect(reconnect).toBe(download);
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'apk_downloading', progress: 0.68 });
    expect(mocks.startup).toHaveBeenCalledOnce();
    expect(session.downloadAppUpdate()).toBe(download);
    expect(session.checkAppUpdateSession()).toBe(download);
    transfer.resolve('file:///verified.apk');
    await download;
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'apk_ready', downloadedPath: 'file:///verified.apk' });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('retains Web progress and readiness across Settings remounts', async () => {
    mocks.startup.mockResolvedValueOnce(result('WEB_UPDATE'));
    await session.ensureAppUpdateSession();
    const transfer = deferred<void>();
    mocks.web.mockImplementationOnce((_target, progress) => { progress(0.5); return transfer.promise; });
    const download = session.downloadAppUpdate();
    await vi.waitFor(() => expect(mocks.web).toHaveBeenCalledOnce());
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'web_downloading', progress: 0.5 });
    expect(session.ensureAppUpdateSession()).toBe(download);
    transfer.resolve();
    await download;
    await session.ensureAppUpdateSession();
    expect(session.getAppUpdateSession().phase).toBe('web_ready');
    expect(mocks.reload).not.toHaveBeenCalled();
    expect(mocks.startup).toHaveBeenCalledOnce();
  });

  it('preserves permission-required and installer-dismissed states without redownloading', async () => {
    await session.ensureAppUpdateSession();
    await session.downloadAppUpdate();
    mocks.install.mockResolvedValueOnce({ status: 'permission_required' });
    const install = session.continueAppUpdateInstall();
    expect(session.continueAppUpdateInstall()).toBe(install);
    await install;
    await session.ensureAppUpdateSession();
    expect(session.getAppUpdateSession().phase).toBe('permission');
    await session.continueAppUpdateInstall();
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'apk_ready', downloadedPath: 'file:///verified.apk' });
    await session.ensureAppUpdateSession();
    await session.continueAppUpdateInstall();
    expect(mocks.apk).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledTimes(3);
  });

  it('keeps cancelling locked until native download drains, then permits a retry', async () => {
    mocks.startup.mockResolvedValueOnce(result('WEB_UPDATE'));
    await session.ensureAppUpdateSession();
    const transfer = deferred<void>();
    let signal!: AbortSignal;
    mocks.web.mockImplementationOnce((_manifest, _progress, abortSignal) => {
      signal = abortSignal;
      return transfer.promise;
    });
    const download = session.downloadAppUpdate();
    await vi.waitFor(() => expect(mocks.web).toHaveBeenCalledOnce());
    expect(session.cancelAppUpdateDownload()).toBe(download);
    expect(signal.aborted).toBe(true);
    expect(session.getAppUpdateSession().phase).toBe('cancelling');
    expect(session.retryAppUpdate()).toBe(download);
    expect(mocks.stop).not.toHaveBeenCalled();
    transfer.reject(new DOMException('cancelled', 'AbortError'));
    await download;
    expect(session.getAppUpdateSession().phase).toBe('cancelled');
    await session.retryAppUpdate();
    expect(mocks.web).toHaveBeenCalledTimes(2);
    expect(session.getAppUpdateSession().phase).toBe('web_ready');
  });

  it('can cancel while the foreground service is starting', async () => {
    await session.ensureAppUpdateSession();
    const service = deferred<void>();
    mocks.start.mockReturnValueOnce(service.promise);
    const download = session.downloadAppUpdate();
    session.cancelAppUpdateDownload();
    service.resolve();
    await download;
    expect(mocks.apk).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(session.getAppUpdateSession().phase).toBe('cancelled');
  });

  it('shows service startup failure without launching unprotected IO', async () => {
    await session.ensureAppUpdateSession();
    mocks.start.mockRejectedValueOnce(new Error('foreground service rejected'));
    await session.downloadAppUpdate();
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'error', message: 'foreground service rejected' });
    expect(mocks.apk).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    await session.retryAppUpdate();
    expect(session.getAppUpdateSession().phase).toBe('apk_ready');
  });

  it('holds the slot through service cleanup and retains failure for retry', async () => {
    await session.ensureAppUpdateSession();
    const cleanup = deferred<void>();
    mocks.stop.mockReturnValueOnce(cleanup.promise);
    mocks.apk.mockRejectedValueOnce(new Error('checksum mismatch'));
    const download = session.downloadAppUpdate();
    await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    expect(session.downloadAppUpdate()).toBe(download);
    cleanup.resolve();
    await download;
    expect(session.getAppUpdateSession()).toMatchObject({ phase: 'error', message: 'checksum mismatch' });
    await session.retryAppUpdate();
    expect(session.getAppUpdateSession().phase).toBe('apk_ready');
  });
});

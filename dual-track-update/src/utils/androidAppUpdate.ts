import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';


export interface AndroidUpdateManifest {
  schemaVersion: 1;
  versionCode: number;
  versionName: string;
  apkUrl: string;
  sha256: string;
  sizeBytes: number;
  publishedAt?: string;
  releaseNotes: string[];
}

export interface InstalledAndroidAppInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
  certificateSha256: string;
  canRequestPackageInstalls: boolean;
  runtimeId?: number;
}

interface VerifiedAndroidApk extends InstalledAndroidAppInfo {
  valid: boolean;
}

interface InstallAndroidApkResult {
  status: 'permission_required' | 'installer_opened';
}

interface ApkInstallerPlugin {
  getInstalledInfo(): Promise<InstalledAndroidAppInfo>;
  startUpdateDownloadService(): Promise<void>;
  stopUpdateDownloadService(): Promise<void>;
  downloadApk(options: { taskId: string; url: string }): Promise<{ path: string }>;
  cancelApkDownload(options: { taskId: string }): Promise<void>;
  addListener(event: 'apkDownloadProgress', listener: (event: {
    taskId: string; bytes: number; contentLength: number;
  }) => void): Promise<PluginListenerHandle>;
  verifyApk(options: {
    path: string;
    sha256: string;
    sizeBytes?: number;
    versionCode?: number;
  }): Promise<VerifiedAndroidApk>;
  installApk(options: { path: string; sha256: string; sizeBytes: number; versionCode: number }): Promise<InstallAndroidApkResult>;
  openInstallPermissionSettings(): Promise<void>;
  openAppDetailsSettings(): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<{ ignoring: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<{ status: string }>;
}

const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller');



const MAX_DOWNLOAD_RETRIES = 3;

// Manifest 毒化/拒绝服务循环防御：记录校验失败的版本号与时间戳，24 小时内不重复发起骚扰
// 设备本地的冷却记录，不属于用户数据，不进入备份。
const FAILED_UPDATE_RECORD_KEY = 'os_failed_android_update_record';
const FAILED_UPDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface FailedUpdateRecord {
  versionCode: number;
  failedAt: number;
  reason: string;
}

const reportCooldownFailure = (operation: 'read' | 'write' | 'clear', error: unknown): void => {
  // This optional local journal must never hide the real transfer/verification result.
  console.warn('[AndroidUpdate] Optional cooldown journal failed', { operation, key: FAILED_UPDATE_RECORD_KEY, error });
};
const isFailedUpdateRecord = (value: unknown): value is FailedUpdateRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<FailedUpdateRecord>;
  return Number.isSafeInteger(record.versionCode) && Number(record.versionCode) > 0
    && Number.isSafeInteger(record.failedAt) && Number(record.failedAt) >= 0
    && typeof record.reason === 'string';
};
export const getFailedUpdateRecord = (): FailedUpdateRecord | null => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    const raw = localStorage.getItem(FAILED_UPDATE_RECORD_KEY);
    if (raw === null) return null;
    const record: unknown = JSON.parse(raw);
    if (!isFailedUpdateRecord(record)) throw new Error('Invalid cooldown journal record');
    return record;
  } catch (error) {
    reportCooldownFailure('read', error);
    return null;
  }
};

export const isVersionInCooldown = (versionCode: number): boolean => {
  const record = getFailedUpdateRecord();
  if (!record || record.versionCode !== versionCode) return false;
  const elapsed = Date.now() - record.failedAt;
  return elapsed >= 0 && elapsed < FAILED_UPDATE_COOLDOWN_MS;
};

export const recordVersionVerificationFailure = (versionCode: number, reason: string): void => {
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new Error('Invalid cooldown versionCode');
  try {
    const record: FailedUpdateRecord = {
      versionCode,
      failedAt: Date.now(),
      reason: String(reason || '校验未通过').slice(0, 1024),
    };
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    localStorage.setItem(FAILED_UPDATE_RECORD_KEY, JSON.stringify(record));
  } catch (error) { reportCooldownFailure('write', error); }
};

export const clearVersionCooldown = (): void => {
  try {
    if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
    localStorage.removeItem(FAILED_UPDATE_RECORD_KEY);
  } catch (error) { reportCooldownFailure('clear', error); }
};

export const getAndroidUpdateManifestUrl = (): string =>
  String(
    import.meta.env.VITE_APK_UPDATE_MANIFEST_URL
    || 'https://github.com/your-name/your-app-releases/releases/latest/download/update-manifest.json',
  ).trim();

export const isAndroidAppUpdateEnabled = (): boolean =>
  Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
  && /^https:\/\//i.test(getAndroidUpdateManifestUrl());

export const parseAndroidUpdateManifest = (input: unknown): AndroidUpdateManifest => {
  if (!input || typeof input !== 'object') throw new Error('更新清单格式无效');
  const value = input as Record<string, unknown>;
  const versionCode = Number(value.versionCode);
  const sizeBytes = Number(value.sizeBytes);
  const versionName = typeof value.versionName === 'string' ? value.versionName.trim() : '';
  const apkUrl = typeof value.apkUrl === 'string' ? value.apkUrl.trim() : '';
  const sha256 = typeof value.sha256 === 'string'
    ? value.sha256.trim().replace(/^sha256:/i, '').toLowerCase()
    : '';
  if (Number(value.schemaVersion) !== 1) throw new Error('暂不支持这份更新清单');
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || !versionName) throw new Error('更新版本号无效');
  if (!/^https:\/\//i.test(apkUrl)) throw new Error('APK 下载地址必须使用 HTTPS');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('APK SHA-256 无效');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('APK 文件大小无效');
  return {
    schemaVersion: 1,
    versionCode,
    versionName,
    apkUrl,
    sha256,
    sizeBytes,
    publishedAt: typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
    releaseNotes: Array.isArray(value.releaseNotes)
      ? value.releaseNotes.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
      : [],
  };
};

export const getInstalledAndroidAppInfo = (): Promise<InstalledAndroidAppInfo> =>
  ApkInstaller.getInstalledInfo();

export const fetchAndroidUpdateManifest = async (): Promise<AndroidUpdateManifest> => {
  const manifestUrl = getAndroidUpdateManifestUrl();
  if (!/^https:\/\//i.test(manifestUrl)) throw new Error('当前安装包没有配置更新地址');

  const url = new URL(manifestUrl);
  url.searchParams.set('_', String(Date.now()));

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      method: 'GET',
      url: url.toString(),
      headers: {
        Accept: 'application/json',
      },
      connectTimeout: 10_000,
      readTimeout: 10_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`检查更新失败（HTTP ${response.status}）`);
    }
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return parseAndroidUpdateManifest(data);
  }

  const response = await fetch(url.toString(), { cache: 'no-store' });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  return parseAndroidUpdateManifest(await response.json());
};

export const startUpdateDownloadService = (): Promise<void> =>
  ApkInstaller.startUpdateDownloadService();

export const stopUpdateDownloadService = (): Promise<void> =>
  ApkInstaller.stopUpdateDownloadService();

export interface DownloadDiagnosticOptions {
  trigger?: 'user_click' | 'app_resume' | 'retry' | 'restore_existing_task';
  taskId?: string;
  signal?: AbortSignal;
}

let activeApkTask: string | null = null;
let taskCounter = 0;

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('更新下载已取消', 'AbortError');
};

const waitForRetry = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfCancelled(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('更新下载已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const downloadAndVerifyAndroidUpdate = async (
  manifest: AndroidUpdateManifest,
  onProgress?: (fraction: number) => void,
  options?: DownloadDiagnosticOptions,
): Promise<string> => {
  // The native destination is shared: release this slot only after IO and verification settle.
  if (activeApkTask) throw new Error('已有 APK 下载任务正在运行');
  const taskId = options?.taskId || `apk_${manifest.versionCode}_${++taskCounter}`;
  const signal = options?.signal;
  throwIfCancelled(signal);
  activeApkTask = taskId;
  let progressHandle: PluginListenerHandle | null = null;
  let lastError: unknown;
  const cancel = () => {
    void ApkInstaller.cancelApkDownload({ taskId }).catch(error => {
      console.error('[AndroidUpdate] 取消原生下载失败:', error);
    });
  };
  try {
    if (onProgress) {
      progressHandle = await ApkInstaller.addListener('apkDownloadProgress', event => {
        if (event.taskId !== taskId || signal?.aborted) return;
        const total = event.contentLength > 0 ? event.contentLength : manifest.sizeBytes;
        onProgress(Math.max(0, Math.min(1, event.bytes / total)));
      });
    }
    signal?.addEventListener('abort', cancel, { once: true });
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
      throwIfCancelled(signal);
      onProgress?.(0);
      let path: string;
      try {
        // Native connect/read timeouts stop actual IO. Never race an uncancellable transfer
        // against a JS timer: that would let the next attempt overwrite its live file.
        ({ path } = await ApkInstaller.downloadApk({ taskId, url: manifest.apkUrl }));
      } catch (error) {
        throwIfCancelled(signal);
        lastError = error;
        if (attempt === MAX_DOWNLOAD_RETRIES) throw error;
        await waitForRetry(2 ** (attempt - 1) * 1000, signal);
        continue;
      }
      throwIfCancelled(signal);
      const verified = await ApkInstaller.verifyApk({
        path, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, versionCode: manifest.versionCode,
      });
      throwIfCancelled(signal);
      if (!verified.valid || verified.versionCode !== manifest.versionCode) {
        throw new Error('下载的 APK 与更新清单版本不一致');
      }
      clearVersionCooldown();
      onProgress?.(1);
      return path;
    }
    throw lastError;
  } catch (error) {
    // User cancellation must never poison the version cooldown.
    if (!signal?.aborted) {
      recordVersionVerificationFailure(manifest.versionCode, error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      await progressHandle?.remove();
    } finally {
      activeApkTask = null;
    }
  }
};
export const installVerifiedAndroidUpdate = (
  path: string,
  manifest: AndroidUpdateManifest,
): Promise<InstallAndroidApkResult> => ApkInstaller.installApk({
  path, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, versionCode: manifest.versionCode,
});

export const requestInstallPermission = (): Promise<void> =>
  ApkInstaller.openInstallPermissionSettings();

export const openAppDetailsSettings = (): Promise<void> =>
  ApkInstaller.openAppDetailsSettings();

export const isIgnoringBatteryOptimizations = async (): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) return true;
  try {
    const res = await ApkInstaller.isIgnoringBatteryOptimizations();
    return !!res.ignoring;
  } catch {
    return false;
  }
};

export const requestIgnoreBatteryOptimizations = async (): Promise<string> => {
  if (!Capacitor.isNativePlatform()) return 'not_supported';
  try {
    const res = await ApkInstaller.requestIgnoreBatteryOptimizations();
    return res.status;
  } catch {
    return 'error';
  }
};

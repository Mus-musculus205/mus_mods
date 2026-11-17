import {
  clearVersionCooldown,
  downloadAndVerifyAndroidUpdate,
  installVerifiedAndroidUpdate,
  startUpdateDownloadService,
  stopUpdateDownloadService,
  type AndroidUpdateManifest,
} from './androidAppUpdate';
import {
  downloadAndApplyWebUpdate,
  reloadWebRuntime,
  resetWebBundle,
  type WebUpdateManifest,
} from './webUpdate';
import { checkForAppUpdates, startAppUpdateCheckOnce } from './appUpdateCheck';
import { BUILD_NUMBER } from './buildInfo';

export type AppUpdatePhase =
  | 'idle' | 'checking' | 'web_available' | 'apk_available'
  | 'web_downloading' | 'apk_downloading' | 'web_ready' | 'apk_ready'
  | 'permission' | 'installing' | 'latest' | 'cooldown' | 'error'
  | 'cancelling' | 'cancelled';

export interface AppUpdateSession {
  phase: AppUpdatePhase;
  manifest: AndroidUpdateManifest | null;
  webManifest: WebUpdateManifest | null;
  downloadedPath: string;
  progress: number;
  message: string;
}

// Owner/authority: this application session. React only subscribes to snapshots.
// Lifecycle: retained across Settings unmounts; no new durable business state.
let snapshot: AppUpdateSession = {
  phase: 'idle', manifest: null, webManifest: null, downloadedPath: '', progress: 0, message: '',
};
const subscribers = new Set<() => void>();
let flight: Promise<void> | null = null;
let downloadController: AbortController | null = null;

export const getAppUpdateSession = (): AppUpdateSession => snapshot;
export const subscribeAppUpdateSession = (subscriber: () => void): (() => void) => {
  subscribers.add(subscriber);
  return () => { subscribers.delete(subscriber); };
};

const update = (patch: Partial<AppUpdateSession>) => {
  snapshot = { ...snapshot, ...patch };
  subscribers.forEach(subscriber => subscriber());
};

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return /Failed to fetch|NetworkError|timeout/i.test(message)
    ? '网络连接失败，请稍后重试' : message;
};

export const isAppUpdateBusy = (phase: AppUpdatePhase): boolean =>
  ['checking', 'web_downloading', 'apk_downloading', 'installing', 'cancelling'].includes(phase);

const run = (phase: AppUpdatePhase, message: string, operation: () => Promise<void>): Promise<void> => {
  if (flight) return flight;
  // Reserve synchronously before notifying UI or awaiting native calls.
  flight = Promise.resolve().then(operation).catch(error => {
    update({ phase: 'error', message: errorMessage(error) });
    console.error('[AppUpdateSession] 更新操作失败:', error);
  }).finally(() => { flight = null; });
  update({ phase, message });
  return flight;
};

export const checkAppUpdateSession = (useStartupResult = false): Promise<void> => {
  if (flight) return flight;
  return run('checking', '', async () => {
    const { installed, strategy } = useStartupResult
      ? await startAppUpdateCheckOnce() : await checkForAppUpdates();
    const target = {
      manifest: strategy.apkManifest || null,
      webManifest: strategy.webManifest || null,
      downloadedPath: '', progress: 0, message: strategy.reason,
    };
    switch (strategy.action) {
      case 'APK_UPDATE':
        update({ ...target, webManifest: null, phase: 'apk_available' });
        break;
      case 'BLOCK_APK_COOLDOWN':
        update({ ...target, webManifest: null, phase: 'cooldown' });
        break;
      case 'WEB_UPDATE':
        update({ ...target, manifest: null, phase: 'web_available' });
        break;
      case 'WEB_UPDATE_PENDING_RELOAD':
        update({ ...target, manifest: null, phase: 'web_ready' });
        break;
      case 'ERROR':
      case 'APK_CHECK_FAILED':
        update({ ...target, manifest: null, webManifest: null, phase: 'error' });
        break;
      case 'RUNTIME_MISMATCH':
        update({ ...target, manifest: null, webManifest: null, phase: 'latest' });
        break;
      default:
        update({ ...target, manifest: null, webManifest: null, phase: 'latest', message: `当前 ${installed.versionName || installed.versionCode} (构建 #${BUILD_NUMBER}) 已是最新版` });
    }
  });
};

/** Remounting Settings reconnects to the task; it must not rerun checks over it. */
export const ensureAppUpdateSession = (): Promise<void> =>
  snapshot.phase === 'idle' ? checkAppUpdateSession(true) : flight || Promise.resolve();

export const downloadAppUpdate = (): Promise<void> => {
  if (flight) return flight;
  const { manifest, webManifest } = snapshot;
  if (!manifest && !webManifest) return checkAppUpdateSession();
  const controller = new AbortController();
  downloadController = controller;
  const signal = controller.signal;
  return run(manifest ? 'apk_downloading' : 'web_downloading', '正在下载，可退出设置或切换应用', async () => {
    let serviceStarted = false;
    let path = '';
    let failure: unknown;
    let hasFailed = false;
    update({ progress: 0, downloadedPath: '' });
    try {
      await startUpdateDownloadService();
      serviceStarted = true;
      if (signal.aborted) throw new DOMException('更新下载已取消', 'AbortError');
      const onProgress = (progress: number) => {
        if (!signal.aborted) update({ progress });
      };
      if (manifest) {
        path = await downloadAndVerifyAndroidUpdate(manifest, onProgress, { signal });
      } else {
        await downloadAndApplyWebUpdate(webManifest!, onProgress, signal);
      }
    } catch (error) {
      hasFailed = true;
      failure = error;
    } finally {
      // The transfer is settled; cancellation can no longer discard a staged update.
      downloadController = null;
      // Keep the slot occupied until native IO, verification and service cleanup finish.
      if (serviceStarted) await stopUpdateDownloadService();
    }
    const isAbortError = failure instanceof Error && failure.name === 'AbortError';
    if (signal.aborted && (!hasFailed || isAbortError)) {
      update({ phase: 'cancelled', progress: 0, message: '下载已取消，可重新下载' });
      return;
    }
    if (hasFailed) throw failure;
    update({
      phase: manifest ? 'apk_ready' : 'web_ready', downloadedPath: path, progress: 1,
      message: manifest ? '安装包已下载并校验，点击继续安装' : '更新已就绪，点击立即生效',
    });
  });
};

export const cancelAppUpdateDownload = (): Promise<void> => {
  if (!downloadController || !flight) return Promise.resolve();
  const isWebDownload = snapshot.webManifest !== null && snapshot.manifest === null;
  update({ phase: 'cancelling', message: isWebDownload
    ? '正在取消，等待原生热更任务结束；本次更新不会生效'
    : '正在取消原生下载…' });
  downloadController.abort();
  return flight;
};

export const continueAppUpdateInstall = (): Promise<void> => {
  if (flight) return flight;
  const { manifest, downloadedPath } = snapshot;
  if (!manifest || !downloadedPath) {
    return run('error', '', async () => { throw new Error('安装包尚未就绪，请先下载'); });
  }
  return run('installing', '正在打开安装器…', async () => {
    const result = await installVerifiedAndroidUpdate(downloadedPath, manifest);
    update(result.status === 'permission_required'
      ? { phase: 'permission', message: '需要“安装未知应用”权限，开启后可继续安装，无需重新下载' }
      : { phase: 'apk_ready', message: '已打开 Android 系统安装器；如未完成安装，可点击继续安装' });
  });
};

export const retryAppUpdate = (): Promise<void> => {
  if (flight) return flight;
  if (snapshot.phase === 'cooldown') clearVersionCooldown();
  if (snapshot.downloadedPath) return continueAppUpdateInstall();
  return downloadAppUpdate();
};

export const activateAppWebUpdate = (): Promise<void> =>
  run('installing', '正在重启应用…', reloadWebRuntime);

export const rollbackAppWebUpdate = (): Promise<void> =>
  run('installing', '正在回滚内置版本…', resetWebBundle);

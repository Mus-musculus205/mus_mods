import React, { useEffect, useState, useSyncExternalStore } from 'react';
import {
  isAndroidAppUpdateEnabled, openAppDetailsSettings, requestInstallPermission,
} from '../../utils/androidAppUpdate';
import { getCurrentBundle, isWebUpdateEnabled } from '../../utils/webUpdate';
import {
  activateAppWebUpdate, cancelAppUpdateDownload, checkAppUpdateSession,
  continueAppUpdateInstall, downloadAppUpdate, ensureAppUpdateSession,
  getAppUpdateSession, isAppUpdateBusy, retryAppUpdate, rollbackAppWebUpdate,
  subscribeAppUpdateSession,
} from '../../utils/appUpdateSession';

const AndroidUpdateControl: React.FC = () => {
  const { phase, manifest, webManifest, downloadedPath, progress, message } =
    useSyncExternalStore(subscribeAppUpdateSession, getAppUpdateSession);
  const [isOtaActive, setIsOtaActive] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const isUpdateEnabled = isAndroidAppUpdateEnabled() || isWebUpdateEnabled();

  useEffect(() => {
    let isMounted = true;
    void getCurrentBundle().then(bundle => {
      if (isMounted) setIsOtaActive(Boolean(bundle.bundleId));
    }).catch(error => console.warn('[UpdateControl] 无法读取当前热更版本:', error));
    return () => { isMounted = false; };
  }, []);

  useEffect(() => {
    if (isUpdateEnabled) void ensureAppUpdateSession();
    // Unmount only removes React's subscription. The app owns the task.
  }, [isUpdateEnabled]);

  const openSettings = async (operation: () => Promise<void>) => {
    setSettingsError('');
    try {
      await operation();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!isUpdateEnabled) return null;

  const isBusy = isAppUpdateBusy(phase);
  const isDownloading = phase === 'apk_downloading' || phase === 'web_downloading';
  const canInstall = phase === 'apk_ready' || phase === 'permission'
    || (phase === 'error' && Boolean(downloadedPath));
  const canRetry = phase === 'cancelled' || phase === 'cooldown'
    || (phase === 'error' && Boolean(manifest || webManifest));

  const label =
    phase === 'checking' ? '检查中…'
      : phase === 'web_downloading' ? `热更新下载中 ${Math.round(progress * 100)}%`
      : phase === 'apk_downloading' ? `APK 下载中 ${Math.round(progress * 100)}%`
      : phase === 'cancelling' ? '正在取消…'
      : phase === 'installing' ? '正在打开更新…'
      : phase === 'web_available' ? `下载热更新 (#${webManifest?.buildNumber || ''})`
      : phase === 'apk_available' ? `下载 ${manifest?.versionName || '新版本'}`
      : phase === 'web_ready' ? '点击立即生效'
      : canInstall ? '继续安装'
      : phase === 'cooldown' ? '忽略冷却并重试'
      : canRetry ? '重新下载'
      : '检查更新';

  const onClick = phase === 'web_available' || phase === 'apk_available' ? downloadAppUpdate
    : phase === 'web_ready' ? activateAppWebUpdate
    : canInstall ? continueAppUpdateInstall
    : canRetry ? retryAppUpdate
    : () => checkAppUpdateSession();

  const notes = webManifest?.releaseNotes || manifest?.releaseNotes || [];

  return (
    <div className="mt-2 flex flex-col items-center gap-1.5">
      {phase === 'permission' ? (
        <div className="flex flex-col items-center gap-2">
          <button type="button"
            onClick={() => void openSettings(requestInstallPermission)}
            className="rounded-full bg-amber-100 px-4 py-2 text-[11px] font-bold text-amber-800 transition-transform active:scale-95">
            前往系统开启“允许安装未知应用”
          </button>
          <button type="button" onClick={() => void continueAppUpdateInstall()} disabled={isBusy}
            className="rounded-full bg-violet-100 px-4 py-1.5 text-[11px] font-bold text-violet-700 transition-transform active:scale-95 disabled:opacity-60">
            已开启权限，继续安装
          </button>
          <button type="button" onClick={() => void openSettings(openAppDetailsSettings)}
            className="text-[10px] text-slate-500 underline hover:text-slate-700 active:opacity-70">
            直达系统应用详情页（解除受限设置）
          </button>
          <p className="max-w-[280px] text-center text-[9px] leading-relaxed text-slate-400">
            提示：若开关呈灰色不可点，请在系统应用详情页右上角菜单（三个点）中选择“允许受限设置”后再开启。
          </p>
        </div>
      ) : (
        <button type="button" onClick={() => void onClick()} disabled={isBusy}
          className="rounded-full bg-violet-100 px-4 py-2 text-[11px] font-bold text-violet-700 transition-transform active:scale-95 disabled:opacity-60">
          {label}
        </button>
      )}
      {(isDownloading || phase === 'cancelling') && (
        <>
          <div className="h-1 w-40 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-violet-400 transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-[10px] text-slate-400">可退出设置，下载完成后返回这里继续更新</p>
          <button type="button" disabled={phase === 'cancelling'}
            onClick={() => void cancelAppUpdateDownload()}
            className="text-[10px] text-slate-500 underline disabled:opacity-60">
            取消下载
          </button>
        </>
      )}
      {(settingsError || message) && (
        <p className={`max-w-[280px] text-center text-[10px] leading-relaxed ${
          settingsError || phase === 'error' || phase === 'cooldown' ? 'text-rose-500' : 'text-slate-400'
        }`}>{settingsError || message}</p>
      )}
      {notes.length > 0 && (
        <ul className="max-w-[300px] list-disc space-y-0.5 pl-5 text-left text-[9px] leading-relaxed text-slate-400">
          {notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
        </ul>
      )}
      {isOtaActive && (
        <button type="button" disabled={isBusy}
          onClick={() => {
            if (window.confirm('确认回滚至安装包内置的原始版本并重启？')) void rollbackAppWebUpdate();
          }}
          className="mt-1 text-[9px] text-amber-600/80 hover:text-amber-700 underline transition-colors">
          已运行于热更新分片 (点此回滚内置版本)
        </button>
      )}
    </div>
  );
};

export default AndroidUpdateControl;

import {
  fetchAndroidUpdateManifest,
  getInstalledAndroidAppInfo,
  isAndroidAppUpdateEnabled,
  isVersionInCooldown,
} from './androidAppUpdate';
import {
  fetchWebUpdateManifest,
  getNextBundle,
  isWebUpdateEnabled,
} from './webUpdate';
import { BUILD_NUMBER } from './buildInfo';
import { resolveUpdateStrategy, type UpdateStrategyDecision } from './updateStrategy';

export interface AppUpdateCheckResult {
  installed: Awaited<ReturnType<typeof getInstalledAndroidAppInfo>>;
  strategy: UpdateStrategyDecision;
}

export const isAppUpdateCheckEnabled = (): boolean =>
  isAndroidAppUpdateEnabled() || isWebUpdateEnabled();

export const checkForAppUpdates = async (): Promise<AppUpdateCheckResult> => {
  const installed = await getInstalledAndroidAppInfo();

  let apkManifest = null;
  let apkError: unknown = null;
  try {
    apkManifest = await fetchAndroidUpdateManifest();
  } catch (error) {
    apkError = error;
  }

  let webManifest = null;
  let webError: unknown = null;
  if (isWebUpdateEnabled()) {
    try {
      webManifest = await fetchWebUpdateManifest();
    } catch (error) {
      webError = error;
    }
  }

  let nextBundleId: string | null = null;
  try {
    nextBundleId = (await getNextBundle()).bundleId;
  } catch (error) {
    console.warn('[AppUpdateCheck] 无法读取待生效 Web Bundle:', error);
  }

  return {
    installed,
    strategy: resolveUpdateStrategy({
      installed: {
        versionCode: installed.versionCode,
        runtimeId: installed.runtimeId,
      },
      currentWebBuildNumber: BUILD_NUMBER,
      apkManifest,
      apkError,
      isApkInCooldown: apkManifest ? isVersionInCooldown(apkManifest.versionCode) : false,
      webManifest,
      webError,
      nextBundleId,
    }),
  };
};

let startupCheckPromise: Promise<AppUpdateCheckResult> | null = null;

/** 进程生命周期内只检查一次；结果缓存给稍后打开的设置页复用。 */
export const startAppUpdateCheckOnce = (): Promise<AppUpdateCheckResult> => {
  if (!isAppUpdateCheckEnabled()) {
    return Promise.reject(new Error('当前平台未启用应用更新检查'));
  }
  if (!startupCheckPromise) startupCheckPromise = checkForAppUpdates();
  return startupCheckPromise;
};

export const resetStartupAppUpdateCheckForTest = () => {
  startupCheckPromise = null;
};

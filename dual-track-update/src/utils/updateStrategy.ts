import type { AndroidUpdateManifest } from './androidAppUpdate';

export interface WebUpdateManifest {
  schemaVersion: 2;
  bundleId: string;
  buildNumber: number;
  webVersion: string;
  sourceSha: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  runtimeId: number;
  publishedAt?: string;
  releaseNotes?: string[];
  signatureAlgorithm?: 'ECDSA_P256_SHA256';
  keyId?: string;
  signature?: string;
}

export type UpdateStrategyKind =
  | 'APK_CHECK_FAILED'
  | 'APK_UPDATE'
  | 'BLOCK_APK_COOLDOWN'
  | 'RUNTIME_MISMATCH'
  | 'WEB_UPDATE_PENDING_RELOAD'
  | 'WEB_UPDATE'
  | 'LATEST'
  | 'ERROR';

export type ApkAvailabilityStatus = 'update_available' | 'cooldown' | 'latest' | 'unknown';

export interface UpdateStrategyDecision {
  action: UpdateStrategyKind;
  reason: string;
  apkStatus?: ApkAvailabilityStatus;
  apkManifest?: AndroidUpdateManifest;
  webManifest?: WebUpdateManifest;
}

export interface ResolveUpdateStrategyParams {
  installed: {
    versionCode: number;
    runtimeId?: number | null;
  };
  currentWebBuildNumber: number;
  apkManifest?: AndroidUpdateManifest | null;
  apkError?: unknown;
  isApkInCooldown?: boolean;
  webManifest?: WebUpdateManifest | null;
  webError?: unknown;
  currentBundleId?: string | null;
  nextBundleId?: string | null;
}

/**
 * 客户端双轨更新纯策略决策函数
 *
 * 遵循系统不变量：
 * 1. 优先底座：若底座有更高版本，强制提示升级 APK，Web 通道冻结；
 * 2. 解耦独立：若底座 manifest 拉取失败，仅标记底座状态 unknown，不阻断兼容的 Web OTA；
 * 3. 门禁检查：web.runtimeId !== installed.runtimeId 时拦截该不兼容补丁；
 * 4. 真实版本：buildNumber 单调数值排序；即使 bundleId 为 null，buildNumber 达标亦为最新；
 * 5. 状态诚实：Web 清单拉取失败时返回 ERROR，严禁伪装为 LATEST（当前已是最新版）；
 * 6. 幂等优化：若 nextBundleId 已等于目标 bundleId，跳过重复下载，提示待重启生效。
 */
export const resolveUpdateStrategy = (
  params: ResolveUpdateStrategyParams,
): UpdateStrategyDecision => {
  // 1. 底座状态评估：若底座 manifest 存在且无错误，比对底座版本
  const hasApkManifest = Boolean(params.apkManifest && !params.apkError);
  const apkStatus: ApkAvailabilityStatus = hasApkManifest ? 'latest' : 'unknown';

  if (hasApkManifest && params.apkManifest!.versionCode > params.installed.versionCode) {
    if (params.isApkInCooldown) {
      return {
        action: 'BLOCK_APK_COOLDOWN',
        reason: `新版本 ${params.apkManifest!.versionName} 近期校验未通过，已进入安全冷却期`,
        apkStatus: 'cooldown',
        apkManifest: params.apkManifest!,
      };
    }
    return {
      action: 'APK_UPDATE',
      reason: `发现新版本底座 ${params.apkManifest!.versionName}，需升级完整安装包`,
      apkStatus: 'update_available',
      apkManifest: params.apkManifest!,
    };
  }

  // 2. 底座无需更新（或底座查询失败进入 unknown），评估 Web OTA
  // 若 Web 清单获取失败，产生明确错误，严禁伪装为 LATEST ("当前已是最新版")
  if (params.webError) {
    return {
      action: 'ERROR',
      reason: '检查 Web 更新失败',
      apkStatus,
      apkManifest: params.apkManifest || undefined,
    };
  }

  // 若未获取到 Web 清单（如未开启 Web 更新或远端无清单）
  if (!params.webManifest) {
    if (apkStatus === 'unknown') {
      return {
        action: 'APK_CHECK_FAILED',
        reason: '底座版本检测失败，且未获取到有效 Web 更新清单',
        apkStatus: 'unknown',
      };
    }
    return {
      action: 'LATEST',
      reason: '当前已是最新版',
      apkStatus: 'latest',
      apkManifest: params.apkManifest || undefined,
    };
  }

  // 3. Web 原生运行时契约门禁：Native 返回的 installed.runtimeId 必须为合法正整数且与 webManifest.runtimeId 完全匹配
  const isInstalledRuntimeValid =
    typeof params.installed.runtimeId === 'number' &&
    Number.isSafeInteger(params.installed.runtimeId) &&
    params.installed.runtimeId > 0;

  if (!isInstalledRuntimeValid || params.webManifest.runtimeId !== params.installed.runtimeId) {
    return {
      action: 'RUNTIME_MISMATCH',
      reason: 'Web 更新与当前原生运行时不兼容',
      apkStatus,
      apkManifest: params.apkManifest || undefined,
      webManifest: params.webManifest,
    };
  }

  // 4. 构建版本比对：以 buildNumber 单调递增排序。当前已达到或高于远端构建号判定为最新
  if (params.webManifest.buildNumber <= params.currentWebBuildNumber) {
    return {
      action: 'LATEST',
      reason: '当前已是最新版',
      apkStatus,
      apkManifest: params.apkManifest || undefined,
      webManifest: params.webManifest,
    };
  }

  // 5. 待生效优化：如果下次启动的 bundleId 已经指向该构建，无需重复下载
  if (params.nextBundleId && params.nextBundleId === params.webManifest.bundleId) {
    return {
      action: 'WEB_UPDATE_PENDING_RELOAD',
      reason: '更新已就绪，重启以生效',
      apkStatus,
      apkManifest: params.apkManifest || undefined,
      webManifest: params.webManifest,
    };
  }

  // 6. 发现新 Web 版本，允许拉取热更新（即使底座 manifest 暂时获取失败，兼容 Web OTA 也正常可用）
  return {
    action: 'WEB_UPDATE',
    reason: `发现 Web 热更新 (构建 #${params.webManifest.buildNumber})`,
    apkStatus,
    apkManifest: params.apkManifest || undefined,
    webManifest: params.webManifest,
  };
};

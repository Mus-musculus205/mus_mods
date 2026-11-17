/**
 * SullyOS 双轨发布策略纯函数模块
 * 负责 Freshness 四态门禁、累计 Native 差异扫描与发布动作决策
 */

export const NATIVE_AFFECTING_PATHS = [
  /^android\//,                          // 原生 Android 工程、清单、Gradle、Java 代码
  /^capacitor\.config\.json$/,           // Capacitor 核心配置
  /^capacitor\.config\.ts$/,             // Capacitor TS 核心配置
  /^package\.json$/,                     // 依赖清单 (可能增删 Capacitor 插件)
  /^pnpm-lock\.yaml$/,                   // 锁文件 (插件版本变动)
  /^\.github\/workflows\/build-apk\.yml$/, // 构建流水线自身变动
  /^\.github\/workflows\/rebaseline-apk\.yml$/, // 指定 SHA 的 APK 重基线入口
  /^scripts\/release\/(?:computeVersioning|generateWebManifest|publishRelease|prepareRebaseline)\.ts$/, // APK 携带的 Web 资产与发布身份链
  /^utils\/buildInfo\.ts$/,              // 版本定义 (若 RUNTIME_ID 发生改动)
  /^runtime-version\.json$/,             // runtimeId 唯一真实源变动
  /^utils\/nativeSqliteBridge\.ts$/,     // 原生 SQLite 桥接协议变动
];

export type FreshnessState = 'same' | 'stale' | 'diverged' | 'fresh';
export type ReleaseAction = 'apk' | 'web' | 'noop' | 'fail';

export interface ReleaseDecisionResult {
  action: ReleaseAction;
  freshness: FreshnessState;
  reason: string;
  hasNativeChanges: boolean;
}

export const hasNativeChanges = (files: string[]): boolean => {
  return files.some((file) => {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    return NATIVE_AFFECTING_PATHS.some((pattern) => pattern.test(normalized));
  });
};

/**
 * 评估代码新鲜度拓扑关系
 */
export const evaluateFreshness = (
  sourceSha: string,
  deployedHeadSha: string | null,
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean,
): FreshnessState => {
  if (!deployedHeadSha) return 'fresh';
  if (sourceSha.toLowerCase() === deployedHeadSha.toLowerCase()) return 'same';

  // 若 sourceSha 是 deployedHeadSha 的祖先，说明当前提交属于旧历史，已被更新的提交发布覆盖
  if (isAncestor(sourceSha, deployedHeadSha)) return 'stale';

  // 若 deployedHeadSha 是 sourceSha 的祖先，说明提交严格单调向前推进
  if (isAncestor(deployedHeadSha, sourceSha)) return 'fresh';

  // 既非前驱亦非后继，发生分叉
  return 'diverged';
};

export interface ComputeReleaseActionParams {
  sourceSha: string;
  deployedHeadSha: string | null;
  apkBaseSha: string | null;
  isAncestor: (ancestorSha: string, descendantSha: string) => boolean;
  cumulativeDiffFiles: string[];
  forceApkBuild?: boolean;
  /**
   * 可选：被打包进 APK 原生 assets 的前端源文件（例如原生后台任务执行的 JS 包）。
   * 它们位于普通前端目录，路径规则覆盖不到，而 Web 热更新换不掉 APK 内的 assets。
   */
  nativeBundleInputs?: readonly string[];
}

/**
 * 综合 Freshness Guard 与 Compatibility Guard 计算发布动作
 */
export const computeReleaseAction = (
  params: ComputeReleaseActionParams,
): ReleaseDecisionResult => {
  const freshness = evaluateFreshness(
    params.sourceSha,
    params.deployedHeadSha,
    params.isAncestor,
  );

  // 每次合并到发布分支都会先自动发布一次，所以手动强制总是落在「已发布的同一个提交」上；
  // 这里不让 same 把强制吞掉，否则 force_apk_build 永远不生效。
  if (freshness === 'same' && params.forceApkBuild) {
    return {
      action: 'apk',
      freshness,
      reason: `通过 force_apk_build 为已发布的源码 (${params.sourceSha.slice(0, 7)}) 重建完整 APK`,
      hasNativeChanges: false,
    };
  }

  if (freshness === 'same') {
    return {
      action: 'noop',
      freshness,
      reason: `当前源码 (${params.sourceSha.slice(0, 7)}) 与已发布 HEAD 一致，无需重复发布`,
      hasNativeChanges: false,
    };
  }

  if (freshness === 'stale') {
    return {
      action: 'noop',
      freshness,
      reason: `当前提交 (${params.sourceSha.slice(0, 7)}) 落后于远端已发布 HEAD，作为过时任务跳过`,
      hasNativeChanges: false,
    };
  }

  if (freshness === 'diverged') {
    return {
      action: 'fail',
      freshness,
      reason: `当前提交 (${params.sourceSha.slice(0, 7)}) 与已发布 HEAD (${params.deployedHeadSha?.slice(0, 7)}) 拓扑分叉，严禁盲目发布`,
      hasNativeChanges: false,
    };
  }

  // freshness === 'fresh' -> 进入 Compatibility Guard
  // 若未曾记录 apkBaseSha，或累计变更命中原生因子，必须升级底座 APK
  const bundleInputs = new Set((params.nativeBundleInputs ?? []).map(file => file.replace(/\\/g, '/')));
  const bundleChanged = params.cumulativeDiffFiles.some(file => bundleInputs.has(file.replace(/\\/g, '/').replace(/^\.\//, '')));
  const nativeChanged = !params.apkBaseSha || hasNativeChanges(params.cumulativeDiffFiles) || bundleChanged;

  if (nativeChanged) {
    return {
      action: 'apk',
      freshness,
      reason: bundleChanged && !hasNativeChanges(params.cumulativeDiffFiles) && params.apkBaseSha
        ? '累计变更命中 APK 内的后台执行包源码，必须构建并发布完整 APK'
        : '累计变更命中原生 Android 或依赖配置，必须构建并发布完整 APK',
      hasNativeChanges: true,
    };
  }

  // 纯前端变更时，允许通过 force_apk_build 强制升级为完整 APK 构建
  if (params.forceApkBuild) {
    return {
      action: 'apk',
      freshness,
      reason: '通过 force_apk_build 强制将纯 Web 更新覆盖为完整 APK 构建',
      hasNativeChanges: false,
    };
  }

  return {
    action: 'web',
    freshness,
    reason: '纯前端更新，构建并发布轻量 Web Live Update Bundle',
    hasNativeChanges: false,
  };
};

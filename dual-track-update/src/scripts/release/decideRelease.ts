import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { computeReleaseAction } from './releasePolicy';

const runGit = (args: string[], cwd: string = process.cwd()): string => {
  return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
};

const isAncestor = (ancestorSha: string, descendantSha: string, cwd: string = process.cwd()): boolean => {
  try {
    execSync(`git merge-base --is-ancestor ${ancestorSha} ${descendantSha}`, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const getCumulativeDiffFiles = (baseSha: string, targetSha: string, cwd: string = process.cwd()): string[] => {
  try {
    const output = execSync(`git diff --name-only ${baseSha}..${targetSha}`, { cwd, encoding: 'utf8' }).trim();
    if (!output) return [];
    return output.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.warn(`[decideRelease] 无法比对 ${baseSha}..${targetSha} 差异，保守标记为包含 Native 变动:`, err);
    return ['android/force_diff_fallback'];
  }
};

export interface ReleaseBaseline {
  deployedHeadSha: string | null;
  apkBaseSha: string | null;
}

/**
 * 从 releases-repo 中的稳定指针清单直接解析已发布基准 SHA
 * 规则：
 * 1. 两个清单文件是发布的唯一权威源：
 *    - web-update-manifest.json.sourceSha 权威代表当前已发布的 HEAD SHA (deployedHeadSha)
 *    - update-manifest.json.sourceSha 权威代表上一次构建 APK 底座时的基准 SHA (apkBaseSha)
 * 2. 清单文件不存在时返回 null（代表首次安装/全空环境）
 * 3. 清单文件损坏时严禁静默 fallback，强制抛出错误（Fail Loudly）
 */
export const resolveReleaseBaseline = (releasesDir: string): ReleaseBaseline => {
  let deployedHeadSha: string | null = null;
  let apkBaseSha: string | null = null;

  const webManifestPath = path.join(releasesDir, 'web-update-manifest.json');
  const apkManifestPath = path.join(releasesDir, 'update-manifest.json');

  if (fs.existsSync(webManifestPath)) {
    try {
      const raw = fs.readFileSync(webManifestPath, 'utf8');
      const webManifest = JSON.parse(raw);
      if (webManifest && typeof webManifest.sourceSha === 'string' && webManifest.sourceSha.trim()) {
        deployedHeadSha = webManifest.sourceSha.trim().toLowerCase();
      } else {
        throw new Error(`web-update-manifest.json 缺少有效的 sourceSha 字段: ${webManifestPath}`);
      }
    } catch (err: any) {
      throw new Error(`Web 更新清单文件损坏，拒绝继续: ${webManifestPath} (${err?.message || err})`);
    }
  }

  if (fs.existsSync(apkManifestPath)) {
    try {
      const raw = fs.readFileSync(apkManifestPath, 'utf8');
      const apkManifest = JSON.parse(raw);
      if (apkManifest && typeof apkManifest.sourceSha === 'string' && apkManifest.sourceSha.trim()) {
        apkBaseSha = apkManifest.sourceSha.trim().toLowerCase();
      } else {
        throw new Error(`update-manifest.json 缺少有效的 sourceSha 字段: ${apkManifestPath}`);
      }
    } catch (err: any) {
      throw new Error(`APK 更新清单文件损坏，拒绝继续: ${apkManifestPath} (${err?.message || err})`);
    }
  }

  return { deployedHeadSha, apkBaseSha };
};

export const runDecideRelease = (options?: {
  releasesDir?: string;
  sourceSha?: string;
  forceApkBuild?: boolean;
  cwd?: string;
}) => {
  const cwd = options?.cwd || process.cwd();
  const sourceSha = options?.sourceSha || process.env.GITHUB_SHA || runGit(['rev-parse', 'HEAD'], cwd);
  const forceApkBuild = options?.forceApkBuild
    ?? (process.env.FORCE_APK_BUILD === 'true' || process.env.INPUT_FORCE_APK_BUILD === 'true');

  const releasesDir = options?.releasesDir || process.env.RELEASES_DIR || path.resolve(cwd, 'releases-repo');
  let baseline: ReleaseBaseline;
  try {
    baseline = resolveReleaseBaseline(releasesDir);
  } catch (err: any) {
    console.error(`::error::${err?.message || err}`);
    return {
      action: 'fail' as const,
      freshness: 'diverged' as const,
      reason: err?.message || '解析清单基准失败',
      hasNativeChanges: false,
    };
  }

  // 校验快照拓扑序: APK_BASE_SHA <= DEPLOYED_HEAD_SHA
  if (baseline.apkBaseSha && baseline.deployedHeadSha) {
    const validTopology = baseline.apkBaseSha.toLowerCase() === baseline.deployedHeadSha.toLowerCase()
      || isAncestor(baseline.apkBaseSha, baseline.deployedHeadSha, cwd);
    if (!validTopology) {
      console.error(`::error::快照拓扑序冲突: apkBaseSha (${baseline.apkBaseSha}) 不是 deployedHeadSha (${baseline.deployedHeadSha}) 的祖先`);
      return {
        action: 'fail' as const,
        freshness: 'diverged' as const,
        reason: '状态快照破坏拓扑序 (apkBaseSha > deployedHeadSha)',
        hasNativeChanges: false,
      };
    }
  }

  // 提取从 apkBaseSha 到当前 sourceSha 的累计变更清单
  const cumulativeDiffFiles = baseline.apkBaseSha
    ? getCumulativeDiffFiles(baseline.apkBaseSha, sourceSha, cwd)
    : [];

  const decision = computeReleaseAction({
    sourceSha,
    deployedHeadSha: baseline.deployedHeadSha,
    apkBaseSha: baseline.apkBaseSha,
    isAncestor: (a, b) => isAncestor(a, b, cwd),
    cumulativeDiffFiles,
    forceApkBuild,
  });

  console.log('=== SullyOS Release Decision ===');
  console.log(`SOURCE_SHA:        ${sourceSha}`);
  console.log(`DEPLOYED_HEAD_SHA: ${baseline.deployedHeadSha || '(none)'}`);
  console.log(`APK_BASE_SHA:      ${baseline.apkBaseSha || '(none)'}`);
  console.log(`Freshness:         ${decision.freshness}`);
  console.log(`HasNativeChanges:  ${decision.hasNativeChanges}`);
  console.log(`ForceApkBuild:     ${forceApkBuild}`);
  console.log(`Action:            ${decision.action}`);
  console.log(`Reason:            ${decision.reason}`);
  console.log('==============================');

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput && fs.existsSync(path.dirname(githubOutput))) {
    const lines = [
      `action=${decision.action}`,
      `freshness=${decision.freshness}`,
      `has_native_changes=${decision.hasNativeChanges}`,
      `source_sha=${sourceSha}`,
      `deployed_head_sha=${baseline.deployedHeadSha || ''}`,
      `apk_base_sha=${baseline.apkBaseSha || ''}`,
      `decision_reason=${decision.reason.replace(/\n/g, ' ')}`,
    ].join('\n') + '\n';
    fs.appendFileSync(githubOutput, lines, 'utf8');
  }

  return decision;
};

// 若直接运行 CLI
if (process.argv[1] && process.argv[1].endsWith('decideRelease.ts')) {
  const result = runDecideRelease();
  if (result.action === 'fail') {
    process.exit(1);
  }
}

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveReleaseBaseline } from './decideRelease';

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface RebaselineRequest {
  targetSourceSha: string;
  confirmTargetSourceSha: string;
  checkedOutSourceSha: string;
  expectedDeployedHeadSha: string;
  expectedApkBaseSha: string;
  confirmRebaseline: string;
  githubEventName: string;
}

const normalizeSha = (value: string, field: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error(`${field} 必须为完整 40 位 Git SHA`);
  return normalized;
};

export const validateRebaselineRequest = (
  request: RebaselineRequest,
  current: { deployedHeadSha: string | null; apkBaseSha: string | null },
) => {
  if (request.githubEventName !== 'workflow_dispatch') {
    throw new Error('重基线只允许由独立 workflow_dispatch 维护入口触发');
  }
  if (request.confirmRebaseline !== 'REBASELINE') {
    throw new Error('必须输入精确确认词 REBASELINE');
  }

  const targetSourceSha = normalizeSha(request.targetSourceSha, 'target_source_sha');
  const confirmedTarget = normalizeSha(request.confirmTargetSourceSha, 'confirm_target_source_sha');
  const checkedOutSourceSha = normalizeSha(request.checkedOutSourceSha, 'checked-out HEAD');
  const expectedDeployedHeadSha = normalizeSha(request.expectedDeployedHeadSha, 'expected_deployed_head_sha');
  const expectedApkBaseSha = normalizeSha(request.expectedApkBaseSha, 'expected_apk_base_sha');

  if (targetSourceSha !== confirmedTarget || targetSourceSha !== checkedOutSourceSha) {
    throw new Error('目标 SHA、重复确认 SHA 与实际 checkout HEAD 必须完全一致');
  }
  if (!current.deployedHeadSha || !current.apkBaseSha) {
    throw new Error('远端双轨 baseline 不完整，拒绝通过重基线入口初始化');
  }
  if (expectedDeployedHeadSha !== current.deployedHeadSha.toLowerCase()) {
    throw new Error('deployedHeadSha 已变化，重基线授权已过期');
  }
  if (expectedApkBaseSha !== current.apkBaseSha.toLowerCase()) {
    throw new Error('apkBaseSha 已变化，重基线授权已过期');
  }

  return { targetSourceSha, expectedDeployedHeadSha, expectedApkBaseSha };
};

export const runPrepareRebaseline = (options?: { releasesDir?: string; cwd?: string }) => {
  const cwd = options?.cwd || process.cwd();
  const checkedOutSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['cat-file', '-e', `${checkedOutSourceSha}^{commit}`], { cwd, stdio: 'ignore' });
  const releasesDir = options?.releasesDir || process.env.RELEASES_DIR || path.resolve(cwd, 'releases-repo');
  const baseline = resolveReleaseBaseline(releasesDir);
  const validated = validateRebaselineRequest({
    targetSourceSha: process.env.TARGET_SOURCE_SHA || '',
    confirmTargetSourceSha: process.env.CONFIRM_TARGET_SOURCE_SHA || '',
    checkedOutSourceSha,
    expectedDeployedHeadSha: process.env.EXPECTED_DEPLOYED_HEAD_SHA || '',
    expectedApkBaseSha: process.env.EXPECTED_APK_BASE_SHA || '',
    confirmRebaseline: process.env.CONFIRM_REBASELINE || '',
    githubEventName: process.env.GITHUB_EVENT_NAME || '',
  }, baseline);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput && fs.existsSync(path.dirname(githubOutput))) {
    fs.appendFileSync(githubOutput, [
      'action=apk',
      'freshness=diverged',
      'has_native_changes=true',
      `source_sha=${validated.targetSourceSha}`,
      `deployed_head_sha=${validated.expectedDeployedHeadSha}`,
      `apk_base_sha=${validated.expectedApkBaseSha}`,
      'decision_reason=已验证指定源码 SHA 与远端双轨 baseline，执行完整 APK 重基线',
      '',
    ].join('\n'), 'utf8');
  }
  return validated;
};

if (process.argv[1] && process.argv[1].endsWith('prepareRebaseline.ts')) {
  try {
    runPrepareRebaseline();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

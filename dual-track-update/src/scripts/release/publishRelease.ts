import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

export interface PublishReleaseOptions {
  kind: 'web' | 'apk';
  releaseTag: string;
  assets: string[];
  sourceSha?: string;
  title?: string;
  notes?: string;
  isLatest?: boolean;
  publicRepo?: string;
  ghToken?: string;
  releasesRepoDir?: string;
  expectedDeployedHeadSha?: string;
  expectedApkBaseSha?: string;
  exec?: (cmd: string, options?: any) => string | Buffer;
}

const normalizeExpectedSha = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`预期 baseline 不是完整 40 位 SHA: ${value}`);
  return normalized;
};

const assertRemoteBaselinesUnchanged = (
  releasesRepoDir: string,
  expectedDeployedHeadSha: string | undefined,
  expectedApkBaseSha: string | undefined,
  exec: (cmd: string, options?: any) => string | Buffer,
  env: NodeJS.ProcessEnv,
) => {
  const expectedWeb = normalizeExpectedSha(expectedDeployedHeadSha);
  const expectedApk = normalizeExpectedSha(expectedApkBaseSha);
  if (expectedWeb === undefined && expectedApk === undefined) return;

  exec(`git -C "${releasesRepoDir}" fetch origin main`, { env, stdio: 'pipe' });
  const readRemoteSha = (manifestName: string): string | null => {
    let raw: string;
    try {
      raw = String(exec(`git -C "${releasesRepoDir}" show origin/main:${manifestName}`, {
        env,
        stdio: 'pipe',
        encoding: 'utf8',
      }));
    } catch {
      return null;
    }
    const sourceSha = String(JSON.parse(raw).sourceSha || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
      throw new Error(`远端 ${manifestName} 缺少完整 sourceSha，拒绝推进指针`);
    }
    return sourceSha;
  };

  const currentWeb = readRemoteSha('web-update-manifest.json');
  const currentApk = readRemoteSha('update-manifest.json');
  if (expectedWeb !== undefined && currentWeb !== expectedWeb) {
    throw new Error('远端 deployedHeadSha 已变化，发布授权过期，拒绝推进指针');
  }
  if (expectedApk !== undefined && currentApk !== expectedApk) {
    throw new Error('远端 apkBaseSha 已变化，发布授权过期，拒绝推进指针');
  }
};

/**
 * Release Notes 里记录的源码 Commit。
 *
 * 只认「Commit: <40 位 SHA>」这个标记，不要求它在行首：早期版本建 Release 时把整条
 * 命令的空白压成了单个空格，说明里的换行也一起没了，那些 Release 的说明是一整行
 * （例如 web-v3.10.0-3237）。要求行首的话，这类 Release 在指针推送失败后永远重跑不完。
 */
export const readRecordedCommit = (body: string | undefined): string | null =>
  String(body || '').toLowerCase().match(/(?:^|[\s-])commit:\s*([0-9a-f]{40})(?![0-9a-f])/)?.[1] ?? null;

/**
 * SullyOS 极简发布管道（Artifact-First, Pointer-Last）
 * 1. 先创建不可变 Release 并上传产物
 * 2. 确认产物就绪后，最后更新并推送 releases-repo 中的公共清单指针
 */
export const publishRelease = (options: PublishReleaseOptions): { success: boolean; skipped?: boolean } => {
  const publicRepo = options.publicRepo || process.env.PUBLIC_RELEASES_REPO || 'your-name/your-app-releases';
  const ghToken = options.ghToken || process.env.GH_TOKEN || process.env.RELEASES_REPO_TOKEN;
  const releasesRepoDir = options.releasesRepoDir || path.resolve('releases-repo');
  const exec = options.exec || execSync;
  const sourceSha = (options.sourceSha || process.env.GITHUB_SHA || '').trim();

  if (sourceSha && !/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error(`[publishRelease] SOURCE_SHA 必须为完整 40 位 SHA，实际为: ${sourceSha}`);
  }

  if (!ghToken) {
    console.warn('[publishRelease] 未检测到发布 Token，跳过远端 GitHub Release 与 Pointer 推送');
    return { success: true, skipped: true };
  }

  const env = { ...process.env, GH_TOKEN: ghToken };

  if (fs.existsSync(releasesRepoDir)) {
    assertRemoteBaselinesUnchanged(
      releasesRepoDir,
      options.expectedDeployedHeadSha,
      options.expectedApkBaseSha,
      exec,
      env,
    );
  }

  // ==========================================
  // 1. ARTIFACT FIRST: 确保不可变 Release 创建且产物完整
  // ==========================================
  const requiredAssetNames = options.assets.map((f) => path.basename(f));
  let existingRelease: {
    isDraft: boolean;
    assets: Array<{ name: string }>;
    tagName?: string;
    body?: string;
  } | null = null;

  try {
    const viewJson = exec(
      `gh release view "${options.releaseTag}" --repo "${publicRepo}" --json isDraft,assets,tagName,body`,
      { env, stdio: 'pipe', encoding: 'utf8' },
    );
    existingRelease = JSON.parse(String(viewJson).trim());
  } catch {
    existingRelease = null;
  }

  const latestFlag = options.isLatest ? '--latest' : '--latest=false';
  /** 复用已有 Release 时，从 Release 下载下来的清单所在目录（见场景 2）。 */
  let reusedManifestDir: string | null = null;

  if (!existingRelease) {
    // 场景 1: 不存在 release -> 创建并上传全部产物
    // 注意：因源码仓库与公开发布仓库为独立仓库，严禁跨仓库传递源码 commit 作为 --target，
    // 保持默认使用 release 仓库的默认分支 (main)。真正的源码版本通过 notes 与 manifest 记录。
    console.log(`[publishRelease] 正在创建 Release "${options.releaseTag}" 并上传不可变产物...`);
    const notesArg = options.notes ? `--notes "${options.notes.replace(/"/g, '\\"')}"` : '--notes ""';
    const titleArg = `--title "${options.title || options.releaseTag}"`;
    const assetArgs = options.assets.filter((f) => fs.existsSync(f)).map((f) => `"${f}"`);

    // 按段拼接，不对整条命令做空白替换：说明里的换行要原样进 Release Notes。
    const createCmd = ['gh release create', `"${options.releaseTag}"`, ...assetArgs, `--repo "${publicRepo}"`, titleArg, notesArg, latestFlag].join(' ');
    exec(createCmd, { env, stdio: 'inherit' });
    console.log(`[publishRelease] 不可变产物上传成功: ${options.releaseTag}`);
  } else {
    // 校验 Release 身份一致性 (Provenance Guard):
    // 跨仓库架构下，源码 Commit 权威记录在 Release Notes 与 Manifest 元数据中。
    // 若现有 Release Notes 中记录的源码 Commit 与当前 sourceSha 冲突，严禁复用，防止覆盖或将 Pointer 指向错误 Commit 的产物
    if (sourceSha) {
      const recordedCommit = readRecordedCommit(existingRelease.body);
      if (recordedCommit !== sourceSha.toLowerCase()) {
        throw new Error(
          `[publishRelease] Release "${options.releaseTag}" 的 Release Notes 中的源码 Commit 与当前 SOURCE_SHA (${sourceSha}) 不匹配！拒绝复用未知或冲突产物，已阻断指针推进 (Fail Loudly).`,
        );
      }
    }

    // 检查已存在 Release 完整性 (是否已发布且包含所有必需产物)
    const existingAssetNames = new Set((existingRelease.assets || []).map((a) => a.name));
    const missingAssets = requiredAssetNames.filter((name) => !existingAssetNames.has(name));
    const isComplete = !existingRelease.isDraft && missingAssets.length === 0;

    if (isComplete) {
      // 场景 2: 存在完整 published release -> reuse，跳过重复上传，继续执行 Pointer Last。
      // 指针要指向这个 Release 里实际存着的包：清单从 Release 下载，而不是用这次重新构建的那份
      // （同一提交两次构建出来的包不保证逐字节一致，清单里的哈希会对不上）。
      console.log(`[publishRelease] Release "${options.releaseTag}" 已发布且产物完整，跳过重复上传并继续推进指针`);
      reusedManifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sullyos-release-manifest-'));
    } else {
      // 场景 3: 存在残缺 Release (draft 或缺少 asset) -> 执行 repair 修复。
      // 本次的全部产物一起覆盖上传：只补缺的那个会让包和清单出自两次不同的构建。
      // 指针在这之前从未指向它，没有客户端拿到过残缺版本。
      console.log(`[publishRelease] 检测到残缺 Release "${options.releaseTag}" (isDraft=${existingRelease.isDraft}, missing=[${missingAssets.join(', ')}])，正在执行修复...`);
      const filesToUpload = options.assets.filter((f) => fs.existsSync(f));
      if (filesToUpload.length > 0) {
        const uploadCmd = `gh release upload "${options.releaseTag}" ${filesToUpload.map((f) => `"${f}"`).join(' ')} --repo "${publicRepo}" --clobber`;
        exec(uploadCmd, { env, stdio: 'inherit' });
      }
      if (existingRelease.isDraft) {
        const publishCmd = `gh release edit "${options.releaseTag}" --repo "${publicRepo}" --draft=false ${latestFlag}`;
        exec(publishCmd, { env, stdio: 'inherit' });
      }
      console.log(`[publishRelease] 残缺 Release 修复完毕并正式发布: ${options.releaseTag}`);
    }
  }

  // ==========================================
  // 2. POINTER LAST: 确认产物存在后，原子更新公共指针
  // ==========================================
  if (!fs.existsSync(releasesRepoDir)) {
    console.log(`[publishRelease] 未找到 ${releasesRepoDir}，跳过指针 Git 提交`);
    return { success: true };
  }

  console.log(`[publishRelease] 正在将最新 Manifest 指针推送到 ${publicRepo} 主分支...`);
  assertRemoteBaselinesUnchanged(
    releasesRepoDir,
    options.expectedDeployedHeadSha,
    options.expectedApkBaseSha,
    exec,
    env,
  );
  const copyManifestIfFound = (manifestName: string) => {
    let sourcePath: string | null = null;
    if (reusedManifestDir && requiredAssetNames.includes(manifestName)) {
      // 复用的 Release：清单只认 Release 里那份，下载不到就失败，不退回本地构建出来的那份。
      exec(`gh release download "${options.releaseTag}" --repo "${publicRepo}" --pattern "${manifestName}" --dir "${reusedManifestDir}" --clobber`,
        { env, stdio: 'pipe' });
      const downloaded = path.join(reusedManifestDir, manifestName);
      if (!fs.existsSync(downloaded)) {
        throw new Error(`[publishRelease] 没能从 Release "${options.releaseTag}" 下载到 ${manifestName}，拒绝推进指针`);
      }
      const recordedSha = String(JSON.parse(fs.readFileSync(downloaded, 'utf8')).sourceSha || '').trim().toLowerCase();
      if (sourceSha && recordedSha && recordedSha !== sourceSha.toLowerCase()) {
        throw new Error(`[publishRelease] Release "${options.releaseTag}" 里的 ${manifestName} 记录的 sourceSha 与当前 SOURCE_SHA 不一致，拒绝推进指针`);
      }
      fs.copyFileSync(downloaded, path.join(releasesRepoDir, manifestName));
      return;
    }
    if (fs.existsSync(manifestName)) {
      sourcePath = manifestName;
    } else {
      const assetMatch = options.assets.find(
        (f) => path.basename(f) === manifestName && fs.existsSync(f),
      );
      if (assetMatch) {
        sourcePath = assetMatch;
      }
    }
    if (sourcePath) {
      fs.copyFileSync(sourcePath, path.join(releasesRepoDir, manifestName));
    }
  };

  if (options.kind === 'web') {
    copyManifestIfFound('web-update-manifest.json');
  } else {
    copyManifestIfFound('update-manifest.json');
    copyManifestIfFound('web-update-manifest.json');
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: 'github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: 'github-actions[bot]@users.noreply.github.com',
  };

  const manifestsToStage = options.kind === 'web'
    ? ['web-update-manifest.json']
    : ['update-manifest.json', 'web-update-manifest.json'];
  exec(`git -C "${releasesRepoDir}" add ${manifestsToStage.join(' ')}`, { env: gitEnv, stdio: 'inherit' });
  const statusOutput = String(
    exec(`git -C "${releasesRepoDir}" status --porcelain`, { env: gitEnv, encoding: 'utf8' }) || '',
  ).trim();

  if (statusOutput) {
    const commitMsg = `chore(release): update stable pointers for ${options.kind} (${options.releaseTag})`;
    exec(`git -C "${releasesRepoDir}" commit -m "${commitMsg}"`, { env: gitEnv, stdio: 'inherit' });
    exec(`git -C "${releasesRepoDir}" push origin main`, { env, stdio: 'inherit' });
    console.log(`[publishRelease] Pointer 更新成功推送。`);
  } else {
    console.log(`[publishRelease] Pointer 内容无变动，无需提交。`);
  }

  return { success: true };
};

// 若作为 CLI 运行
if (process.argv[1] && process.argv[1].endsWith('publishRelease.ts')) {
  const kind = (process.argv[2] || process.env.RELEASE_KIND) as 'web' | 'apk';
  if (kind !== 'web' && kind !== 'apk') {
    console.error(`[publishRelease] 无效的 release kind: "${kind}". 必须为 "web" 或 "apk".`);
    process.exit(1);
  }

  const buildNumber = Number(process.env.BUILD_NUMBER) || 0;
  const sourceSha = process.env.GITHUB_SHA || '';

  if (kind === 'web') {
    const webReleaseTag = process.env.WEB_RELEASE_TAG || `web-update-${buildNumber}`;
    publishRelease({
      kind: 'web',
      releaseTag: webReleaseTag,
      assets: ['web-bundle.zip', 'web-update-manifest.json'],
      sourceSha,
      title: `SullyOS Web Live Update #${buildNumber}`,
      notes: `### SullyOS Web Live Update #${buildNumber}\n- Commit: ${sourceSha}\n- 资产: web-bundle.zip`,
      isLatest: false,
      expectedDeployedHeadSha: process.env.EXPECTED_DEPLOYED_HEAD_SHA,
      expectedApkBaseSha: process.env.EXPECTED_APK_BASE_SHA,
    });
  } else {
    const apkReleaseTag = process.env.APK_RELEASE_TAG || `android-${buildNumber}`;
    const versionName = process.env.VERSION_NAME || '';
    publishRelease({
      kind: 'apk',
      releaseTag: apkReleaseTag,
      assets: [
        'SullyOS-latest.apk',
        'update-manifest.json',
        'web-bundle.zip',
        'web-update-manifest.json',
      ],
      sourceSha,
      title: `SullyOS Release ${apkReleaseTag}`,
      notes: `### SullyOS Release ${apkReleaseTag}\n- Version: ${versionName}\n- Commit: ${sourceSha}`,
      isLatest: true,
      expectedDeployedHeadSha: process.env.EXPECTED_DEPLOYED_HEAD_SHA,
      expectedApkBaseSha: process.env.EXPECTED_APK_BASE_SHA,
    });
  }
}

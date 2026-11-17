import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publishRelease, readRecordedCommit } from '../scripts/release/publishRelease';

/** 模拟 `gh release download ... --pattern <name> --dir <dir>`：把 Release 里那份清单写进 --dir。 */
const writeDownloadedManifest = (cmd: string, manifests: Record<string, unknown>) => {
  const name = cmd.match(/--pattern "([^"]+)"/)?.[1];
  const dir = cmd.match(/--dir "([^"]+)"/)?.[1];
  if (name && dir && manifests[name] !== undefined) fs.writeFileSync(path.join(dir, name), JSON.stringify(manifests[name]));
};

describe('scripts/release/publishRelease 极简发布管道单元测试', () => {
  const tmpDir = path.resolve(__dirname, '../node_modules/.tmp-publish-test');
  const releasesRepoDir = path.join(tmpDir, 'releases-repo');
  const webManifestFile = path.join(tmpDir, 'web-update-manifest.json');
  const apkManifestFile = path.join(tmpDir, 'update-manifest.json');
  const webBundleFile = path.join(tmpDir, 'web-bundle.zip');

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(releasesRepoDir, { recursive: true });

    // 预置临时文件
    fs.writeFileSync(webManifestFile, JSON.stringify({ schemaVersion: 2, bundleId: 'test.1' }));
    fs.writeFileSync(apkManifestFile, JSON.stringify({ schemaVersion: 1, versionCode: 100 }));
    fs.writeFileSync(webBundleFile, 'mock-zip-content');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未提供 GH_TOKEN 时安全跳过发布操作', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      return '';
    });

    const result = publishRelease({
      kind: 'web',
      releaseTag: 'web-v1.0.0-1',
      assets: [webBundleFile],
      ghToken: '',
      exec: mockExec,
    });

    expect(result.skipped).toBe(true);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('Artifact-First: 先创建 Release 并上传产物，后更新 Pointer', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        throw new Error('release not found'); // 模拟新 Release
      }
      if (cmd.includes('status --porcelain')) {
        return 'M web-update-manifest.json';
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = publishRelease({
        kind: 'web',
        releaseTag: 'web-v1.0.0-100',
        assets: ['web-bundle.zip', 'web-update-manifest.json'],
      sourceSha: 'a'.repeat(40),
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);

      // 验证顺序：1. gh release view -> 2. gh release create (不含跨仓库 --target) -> 3. git add/commit/push
      const createIndex = executedCommands.findIndex((c) => c.includes('gh release create'));
      const gitPushIndex = executedCommands.findIndex((c) => c.includes('git -C "releases-repo" push'));

      expect(createIndex).toBeGreaterThan(-1);
      expect(executedCommands[createIndex]).not.toContain('--target');
      expect(gitPushIndex).toBeGreaterThan(createIndex);

      // 验证 web-update-manifest 已被复制至 releases-repo
      expect(fs.existsSync(path.join('releases-repo', 'web-update-manifest.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('当产物上传失败时，Pointer 保持原样不被推送', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        throw new Error('not found');
      }
      if (cmd.includes('gh release create')) {
        throw new Error('Network timeout during upload');
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      expect(() =>
        publishRelease({
          kind: 'web',
          releaseTag: 'web-v1.0.0-101',
          assets: ['web-bundle.zip'],
          publicRepo: 'test/repo',
          ghToken: 'mock-gh-token',
          releasesRepoDir: 'releases-repo',
          exec: mockExec,
        }),
      ).toThrow('Network timeout during upload');

      // 验证没有执行 git commit 或 push
      expect(executedCommands.some((c) => c.includes('commit'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('push'))).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('Release 已存在且产物完整时，幂等跳过重复上传', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        return JSON.stringify({
          tagName: 'web-v1.0.0-102',
          isDraft: false,
          assets: [{ name: 'web-bundle.zip' }],
        });
      }
      if (cmd.includes('status --porcelain')) {
        return ''; // 无变动
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = publishRelease({
        kind: 'web',
        releaseTag: 'web-v1.0.0-102',
        assets: ['web-bundle.zip'],
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);
      // 确认未调用任何修改 Release 的命令
      expect(executedCommands.some((c) => c.includes('gh release create'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('gh release upload'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('gh release edit'))).toBe(false);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('Release 为 draft 状态时，执行 repair 取消草稿并推进 Pointer', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        return JSON.stringify({
          tagName: 'web-v1.0.0-103',
          isDraft: true,
          assets: [{ name: 'web-bundle.zip' }],
        });
      }
      if (cmd.includes('status --porcelain')) {
        return 'M web-update-manifest.json';
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = publishRelease({
        kind: 'web',
        releaseTag: 'web-v1.0.0-103',
        assets: ['web-bundle.zip'],
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);
      // 验证未重新 create，但执行了 gh release edit --draft=false
      expect(executedCommands.some((c) => c.includes('gh release create'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('gh release edit') && c.includes('--draft=false'))).toBe(true);
      // 验证 Pointer 推送继续执行
      expect(executedCommands.some((c) => c.includes('git -C "releases-repo" push'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('Release 缺失必要产物时，本次全部产物一起覆盖上传（包与清单同出一次构建）并推进 Pointer', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        return JSON.stringify({
          tagName: 'web-v1.0.0-104',
          isDraft: false,
          assets: [{ name: 'web-update-manifest.json' }], // 缺失 web-bundle.zip
        });
      }
      if (cmd.includes('status --porcelain')) {
        return 'M web-update-manifest.json';
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = publishRelease({
        kind: 'web',
        releaseTag: 'web-v1.0.0-104',
        assets: ['web-bundle.zip', 'web-update-manifest.json'],
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);
      // 验证未调用 create；upload 覆盖了全部产物：只补缺的包会和 Release 里旧的清单对不上
      expect(executedCommands.some((c) => c.includes('gh release create'))).toBe(false);
      const uploadCmd = executedCommands.find((c) => c.includes('gh release upload')) || '';
      expect(uploadCmd).toContain('web-bundle.zip');
      expect(uploadCmd).toContain('web-update-manifest.json');
      expect(uploadCmd).toContain('--clobber');
      // 验证 Pointer 推送继续执行
      expect(executedCommands.some((c) => c.includes('git -C "releases-repo" push'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('核心自愈验证：产物成功、Pointer 失败、同 commit 重跑 => 识别 Release 完整并直接推进 Pointer，使 stable pointer 追平 SOURCE_SHA', () => {
    const commitOld = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const commitTarget = 'cccccccccccccccccccccccccccccccccccccccc';

    // 场景模拟：
    // 1. releases-repo 中 stable pointer 仍指向 commitOld (上次 Pointer push 失败)
    fs.writeFileSync(
      path.join(releasesRepoDir, 'web-update-manifest.json'),
      JSON.stringify({ schemaVersion: 2, sourceSha: commitOld }),
    );

    // 2. 当前工作区重新构建出一份同 commit 的 manifest（包的哈希可能与 Release 里那份不同）
    fs.writeFileSync(
      webManifestFile,
      JSON.stringify({ schemaVersion: 2, sourceSha: commitTarget, bundleId: 'sullyos.web.bundle.105-rebuild' }),
    );
    const releasedManifest = { schemaVersion: 2, sourceSha: commitTarget, bundleId: 'sullyos.web.bundle.105' };

    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        // GitHub Release 事实上在上次运行中已经成功创建并包含所有产物，且 notes 中记录的 Commit 与 commitTarget 一致
        return JSON.stringify({
          tagName: 'web-v1.0.0-105',
          isDraft: false,
          body: `### SullyOS Web Live Update #105\n- Commit: ${commitTarget}\n- 资产: web-bundle.zip`,
          assets: [
            { name: 'web-bundle.zip' },
            { name: 'web-update-manifest.json' },
          ],
        });
      }
      if (cmd.includes('gh release download')) {
        writeDownloadedManifest(cmd, { 'web-update-manifest.json': releasedManifest });
        return '';
      }
      if (cmd.includes('status --porcelain')) {
        // Pointer 清单发生变更 (从 commitOld 变到 commitTarget)
        return 'M web-update-manifest.json';
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);

      // 执行重跑
      const result = publishRelease({
        kind: 'web',
        releaseTag: 'web-v1.0.0-105',
        assets: ['web-bundle.zip', 'web-update-manifest.json'],
        sourceSha: commitTarget,
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);

      // 验证 1: 绝对没有重复创建 Release 或重复上传
      expect(executedCommands.some((c) => c.includes('gh release create'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('gh release upload'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('gh release edit'))).toBe(false);

      // 验证 2: 无论产物是否已存在，一定强制执行 Pointer Last
      expect(executedCommands.some((c) => c.includes('git -C "releases-repo" push origin main'))).toBe(true);

      // 验证 3: releases-repo 中的 stable pointer 最终成功更新并追平当前 SOURCE_SHA (commitTarget)
      const updatedPointerManifest = JSON.parse(
        fs.readFileSync(path.join(releasesRepoDir, 'web-update-manifest.json'), 'utf8'),
      );
      expect(updatedPointerManifest.sourceSha).toBe(commitTarget);
      // 验证 4: 指针用的是 Release 里那份清单，不是这次重新构建的
      expect(updatedPointerManifest.bundleId).toBe('sullyos.web.bundle.105');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('一行说明的旧 Release（换行曾被压成空格）照样认得出来源并完成指针推进', () => {
    const commit = 'abababababababababababababababababababab';
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        return JSON.stringify({
          tagName: 'web-v3.10.0-3237',
          isDraft: false,
          body: `### SullyOS Web Live Update #3237 - Commit: ${commit} - 资产: web-bundle.zip`,
          assets: [{ name: 'web-bundle.zip' }, { name: 'web-update-manifest.json' }],
        });
      }
      if (cmd.includes('gh release download')) {
        writeDownloadedManifest(cmd, { 'web-update-manifest.json': { schemaVersion: 2, sourceSha: commit } });
        return '';
      }
      if (cmd.includes('status --porcelain')) return 'M web-update-manifest.json';
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const result = publishRelease({
        kind: 'web', releaseTag: 'web-v3.10.0-3237', assets: ['web-bundle.zip', 'web-update-manifest.json'],
        sourceSha: commit, publicRepo: 'test/repo', ghToken: 'mock-gh-token', releasesRepoDir: 'releases-repo', exec: mockExec,
      });
      expect(result.success).toBe(true);
      expect(executedCommands.some((c) => c.includes('git -C "releases-repo" push origin main'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('复用 Release 时下载不到清单，或清单记录的 sourceSha 不符，都拒绝推进指针', () => {
    const commit = 'dddddddddddddddddddddddddddddddddddddddd';
    for (const released of [undefined, { schemaVersion: 2, sourceSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }]) {
      const executedCommands: string[] = [];
      const mockExec = vi.fn((cmd: string) => {
        executedCommands.push(cmd);
        if (cmd.includes('gh release view')) {
          return JSON.stringify({
            tagName: 'web-v1.0.0-107', isDraft: false, body: `- Commit: ${commit}`,
            assets: [{ name: 'web-bundle.zip' }, { name: 'web-update-manifest.json' }],
          });
        }
        if (cmd.includes('gh release download')) {
          if (released) writeDownloadedManifest(cmd, { 'web-update-manifest.json': released });
          return '';
        }
        return '';
      });
      const origCwd = process.cwd();
      try {
        process.chdir(tmpDir);
        expect(() => publishRelease({
          kind: 'web', releaseTag: 'web-v1.0.0-107', assets: ['web-bundle.zip', 'web-update-manifest.json'],
          sourceSha: commit, publicRepo: 'test/repo', ghToken: 'mock-gh-token', releasesRepoDir: 'releases-repo', exec: mockExec,
        })).toThrow(/拒绝推进指针/);
        expect(executedCommands.some((c) => c.includes('push'))).toBe(false);
      } finally {
        process.chdir(origCwd);
      }
    }
  });

  it('新建 Release 时说明里的换行原样保留', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) throw new Error('release not found');
      return '';
    });
    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      publishRelease({
        kind: 'web', releaseTag: 'web-v1.0.0-108', assets: ['web-bundle.zip'], notes: '### Title\n- Commit: x\n- 资产: y',
        publicRepo: 'test/repo', ghToken: 'mock-gh-token', releasesRepoDir: 'releases-repo', exec: mockExec,
      });
      const createCmd = executedCommands.find((c) => c.includes('gh release create')) || '';
      expect(createCmd).toContain('--notes "### Title\n- Commit: x\n- 资产: y"');
    } finally {
      process.chdir(origCwd);
    }
  });

  it('readRecordedCommit 认行首、行中和多行三种写法，长度不对的不认', () => {
    const sha = 'abababababababababababababababababababab';
    expect(readRecordedCommit(`### T\n- Commit: ${sha}\n- x`)).toBe(sha);
    expect(readRecordedCommit(`### T - Commit: ${sha} - x`)).toBe(sha);
    expect(readRecordedCommit(`Commit: ${sha.toUpperCase()}`)).toBe(sha);
    expect(readRecordedCommit(`- Commit: ${sha}0`)).toBeNull();
    expect(readRecordedCommit(undefined)).toBeNull();
  });

  it('Provenance Guard: 已存在 Release 的 Notes 中源码 Commit 与当前 SOURCE_SHA 冲突时，Fail Loudly 且严禁推进 Pointer', () => {
    const commitCurrent = '2222222222222222222222222222222222222222';
    const commitConflict = '1111111111111111111111111111111111111111';
    const commitOld = '0000000000000000000000000000000000000000';

    // releases-repo 中 stable pointer 指向 commitOld
    fs.writeFileSync(
      path.join(releasesRepoDir, 'web-update-manifest.json'),
      JSON.stringify({ schemaVersion: 2, sourceSha: commitOld }),
    );

    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) {
        // 现有 Release 产物完整且已发布，但 notes 中记录的源码 Commit 是冲突的 commitConflict
        return JSON.stringify({
          tagName: 'web-v1.0.0-106',
          isDraft: false,
          body: `### SullyOS Web Live Update #106\n- Commit: ${commitConflict}\n- 资产: web-bundle.zip`,
          assets: [
            { name: 'web-bundle.zip' },
            { name: 'web-update-manifest.json' },
          ],
        });
      }
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);

      expect(() =>
        publishRelease({
          kind: 'web',
          releaseTag: 'web-v1.0.0-106',
          assets: ['web-bundle.zip', 'web-update-manifest.json'],
          sourceSha: commitCurrent,
          publicRepo: 'test/repo',
          ghToken: 'mock-gh-token',
          releasesRepoDir: 'releases-repo',
          exec: mockExec,
        }),
      ).toThrow(/Release Notes 中的源码 Commit 与当前 SOURCE_SHA .* 不匹配！拒绝复用未知或冲突产物/);

      // 验证 1: 绝对没有执行任何 git commit 或 git push
      expect(executedCommands.some((c) => c.includes('commit'))).toBe(false);
      expect(executedCommands.some((c) => c.includes('push'))).toBe(false);

      // 验证 2: releases-repo 中的 stable pointer 维持原样未被污染推进
      const pointerManifest = JSON.parse(
        fs.readFileSync(path.join(releasesRepoDir, 'web-update-manifest.json'), 'utf8'),
      );
      expect(pointerManifest.sourceSha).toBe(commitOld);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('APK 发布同时拷贝两份 manifest 并设置 --latest', () => {
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('gh release view')) throw new Error('not found');
      if (cmd.includes('status --porcelain')) return 'M update-manifest.json';
      return '';
    });

    const origCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      fs.writeFileSync('SullyOS-latest.apk', 'mock-apk');

      const result = publishRelease({
        kind: 'apk',
        releaseTag: 'android-v1.0.0-100050',
        assets: ['SullyOS-latest.apk', 'update-manifest.json', 'web-update-manifest.json'],
        publicRepo: 'test/repo',
        ghToken: 'mock-gh-token',
        releasesRepoDir: 'releases-repo',
        exec: mockExec,
      });

      expect(result.success).toBe(true);

      const createCmd = executedCommands.find((c) => c.includes('gh release create')) || '';
      expect(createCmd).toContain('--latest');
      expect(fs.existsSync(path.join('releases-repo', 'update-manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join('releases-repo', 'web-update-manifest.json'))).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('远端 baseline 在授权后变化时，创建 Release 前即拒绝发布', () => {
    const expectedWeb = 'a'.repeat(40);
    const currentWeb = 'b'.repeat(40);
    const apkBase = 'c'.repeat(40);
    const executedCommands: string[] = [];
    const mockExec = vi.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('show origin/main:web-update-manifest.json')) {
        return JSON.stringify({ sourceSha: currentWeb });
      }
      if (cmd.includes('show origin/main:update-manifest.json')) {
        return JSON.stringify({ sourceSha: apkBase });
      }
      return '';
    });

    expect(() => publishRelease({
      kind: 'web',
      releaseTag: 'web-v1.0.0-107',
      assets: ['web-bundle.zip', 'web-update-manifest.json'],
      sourceSha: 'd'.repeat(40),
      publicRepo: 'test/repo',
      ghToken: 'mock-gh-token',
      releasesRepoDir: releasesRepoDir,
      expectedDeployedHeadSha: expectedWeb,
      expectedApkBaseSha: apkBase,
      exec: mockExec,
    })).toThrow(/deployedHeadSha 已变化/);
    expect(executedCommands.some(command => command.includes('gh release'))).toBe(false);
  });
});

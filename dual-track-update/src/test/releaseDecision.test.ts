import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeReleaseAction,
  evaluateFreshness,
  hasNativeChanges,
  NATIVE_AFFECTING_PATHS,
} from '../scripts/release/releasePolicy';
import { resolveReleaseBaseline, runDecideRelease } from '../scripts/release/decideRelease';

describe('scripts/release/releasePolicy 发布决策引擎单元测试', () => {
  const commitA = '1111111111111111111111111111111111111111'; // older commit
  const commitB = '2222222222222222222222222222222222222222'; // middle commit
  const commitC = '3333333333333333333333333333333333333333'; // latest commit
  const commitDiverged = '9999999999999999999999999999999999999999';

  // 模拟 Git 拓扑：A -> B -> C，Diverged 独立分叉
  const mockIsAncestor = (ancestor: string, descendant: string): boolean => {
    if (ancestor === commitA && (descendant === commitB || descendant === commitC)) return true;
    if (ancestor === commitB && descendant === commitC) return true;
    return false;
  };

  describe('NATIVE_AFFECTING_PATHS 影响因子识别', () => {
    it('精确命中原生目录、Capacitor配置、依赖清单、构建流与底层版本', () => {
      expect(hasNativeChanges(['android/app/build.gradle'])).toBe(true);
      expect(hasNativeChanges(['capacitor.config.json'])).toBe(true);
      expect(hasNativeChanges(['capacitor.config.ts'])).toBe(true);
      expect(hasNativeChanges(['package.json'])).toBe(true);
      expect(hasNativeChanges(['pnpm-lock.yaml'])).toBe(true);
      expect(hasNativeChanges(['.github/workflows/build-apk.yml'])).toBe(true);
      expect(hasNativeChanges(['utils/buildInfo.ts'])).toBe(true);
      expect(hasNativeChanges(['runtime-version.json'])).toBe(true);
      expect(hasNativeChanges(['utils/nativeSqliteBridge.ts'])).toBe(true);
    });

    it('纯前端业务代码与文档改动不触发 Native 判定', () => {
      expect(hasNativeChanges(['components/chat/ChatPanel.tsx'])).toBe(false);
      expect(hasNativeChanges(['utils/characterPersona.ts'])).toBe(false);
      expect(hasNativeChanges(['README.md'])).toBe(false);
      expect(hasNativeChanges(['docs/architecture.md'])).toBe(false);
    });
  });

  describe('Freshness 四态门禁判定', () => {
    it('首次发布（deployedHeadSha 为空）判定为 fresh', () => {
      expect(evaluateFreshness(commitC, null, mockIsAncestor)).toBe('fresh');
    });

    it('SOURCE_SHA == DEPLOYED_HEAD_SHA 判定为 same (noop)', () => {
      expect(evaluateFreshness(commitB, commitB, mockIsAncestor)).toBe('same');
    });

    it('DEPLOYED_HEAD_SHA 领先于 SOURCE_SHA 判定为 stale (noop)', () => {
      // 远端已部署 commitC，当前 runner 执行较旧的 commitB
      expect(evaluateFreshness(commitB, commitC, mockIsAncestor)).toBe('stale');
    });

    it('历史图谱分叉判定为 diverged (fail)', () => {
      expect(evaluateFreshness(commitDiverged, commitB, mockIsAncestor)).toBe('diverged');
    });

    it('SOURCE_SHA 领先于 DEPLOYED_HEAD_SHA 判定为 fresh', () => {
      expect(evaluateFreshness(commitC, commitB, mockIsAncestor)).toBe('fresh');
    });
  });

  describe('computeReleaseAction 综合决策计算', () => {
    it('same 状态输出 action = noop', () => {
      const decision = computeReleaseAction({
        sourceSha: commitB,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['android/app/build.gradle'],
      });
      expect(decision.action).toBe('noop');
      expect(decision.freshness).toBe('same');
    });

    it('stale 状态输出 action = noop', () => {
      const decision = computeReleaseAction({
        sourceSha: commitA,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: [],
      });
      expect(decision.action).toBe('noop');
      expect(decision.freshness).toBe('stale');
    });

    it('diverged 状态输出 action = fail (HARD FAIL)', () => {
      const decision = computeReleaseAction({
        sourceSha: commitDiverged,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: [],
      });
      expect(decision.action).toBe('fail');
      expect(decision.freshness).toBe('diverged');
    });

    it('fresh 状态且 APK_BASE_SHA..SOURCE_SHA 包含原生变动时输出 action = apk', () => {
      const decision = computeReleaseAction({
        sourceSha: commitC,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['src/App.tsx', 'android/AndroidManifest.xml'],
      });
      expect(decision.action).toBe('apk');
      expect(decision.freshness).toBe('fresh');
      expect(decision.hasNativeChanges).toBe(true);
    });

    it('fresh 状态且无原生变动时输出 action = web', () => {
      const decision = computeReleaseAction({
        sourceSha: commitC,
        deployedHeadSha: commitB,
        apkBaseSha: commitB,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['src/App.tsx', 'components/Button.tsx'],
      });
      expect(decision.action).toBe('web');
      expect(decision.freshness).toBe('fresh');
      expect(decision.hasNativeChanges).toBe(false);
    });

    it('前次原生构建失败（apkBaseSha 仍为 A），本次仅修改纯前端，仍能根据累计 Diff 触发 apk 构建', () => {
      // 哪怕本次提交只改了 App.tsx，但从上次成功打 APK 的 commitA 累计到当前，包含原生改动
      const decision = computeReleaseAction({
        sourceSha: commitC,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['src/App.tsx', 'android/MainActivity.java'],
      });
      expect(decision.action).toBe('apk');
      expect(decision.hasNativeChanges).toBe(true);
    });

    it('force_apk_build = true 覆盖 web 与 same 为 apk，不覆盖 stale / diverged', () => {
      // 覆盖 web -> apk
      const webDecision = computeReleaseAction({
        sourceSha: commitC,
        deployedHeadSha: commitB,
        apkBaseSha: commitB,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['src/App.tsx'],
        forceApkBuild: true,
      });
      expect(webDecision.action).toBe('apk');
      expect(webDecision.reason).toContain('force_apk_build');

      // 覆盖 same：每次合并都会先自动发布，手动强制总是落在已发布的同一个提交上
      const sameDecision = computeReleaseAction({
        sourceSha: commitB,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: [],
        forceApkBuild: true,
      });
      expect(sameDecision.action).toBe('apk');

      // 不覆盖 stale
      const staleDecision = computeReleaseAction({
        sourceSha: commitA,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: [],
        forceApkBuild: true,
      });
      expect(staleDecision.action).toBe('noop');

      // 不覆盖 diverged
      const divergedDecision = computeReleaseAction({
        sourceSha: commitDiverged,
        deployedHeadSha: commitB,
        apkBaseSha: commitA,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: [],
        forceApkBuild: true,
      });
      expect(divergedDecision.action).toBe('fail');
    });

    it('改到 APK 后台执行包的源码时构建 APK，而不是只发 Web', () => {
      const decision = computeReleaseAction({
        sourceSha: commitC,
        deployedHeadSha: commitB,
        apkBaseSha: commitB,
        isAncestor: mockIsAncestor,
        cumulativeDiffFiles: ['utils/api/channelSelection.ts'],
        nativeBundleInputs: ['utils/native/backgroundTask.ts', 'utils/api/channelSelection.ts'],
      });
      expect(decision.action).toBe('apk');
      expect(decision.reason).toContain('后台执行包');
    });
  });

  describe('resolveReleaseBaseline 稳定指针基准解析测试', () => {
    const tmpDir = path.resolve(__dirname, '../node_modules/.tmp-baseline-test');

    beforeEach(() => {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('优先直接从 web-update-manifest.json 与 update-manifest.json 解析 sourceSha', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'web-update-manifest.json'),
        JSON.stringify({ schemaVersion: 2, sourceSha: 'web-sha-1234567890abcdef' }),
      );
      fs.writeFileSync(
        path.join(tmpDir, 'update-manifest.json'),
        JSON.stringify({ schemaVersion: 1, sourceSha: 'apk-sha-1234567890abcdef' }),
      );

      const baseline = resolveReleaseBaseline(tmpDir);
      expect(baseline.deployedHeadSha).toBe('web-sha-1234567890abcdef');
      expect(baseline.apkBaseSha).toBe('apk-sha-1234567890abcdef');
    });

    it('当清单缺失时直接返回 null (触发首次运行初始化，严禁回退旧状态文件)', () => {
      // 即使目录下遗留了旧版 apk-release-state.json，也坚决无视，返回 null
      fs.writeFileSync(
        path.join(tmpDir, 'apk-release-state.json'),
        JSON.stringify({
          schemaVersion: 1,
          deployedHeadSha: 'legacy-deployed-sha',
          apkBaseSha: 'legacy-apk-sha',
        }),
      );

      const baseline = resolveReleaseBaseline(tmpDir);
      expect(baseline.deployedHeadSha).toBeNull();
      expect(baseline.apkBaseSha).toBeNull();
    });

    it('当所有文件均不存在时返回 null (全新初始化)', () => {
      const baseline = resolveReleaseBaseline(tmpDir);
      expect(baseline.deployedHeadSha).toBeNull();
      expect(baseline.apkBaseSha).toBeNull();
    });

    it('当 web-update-manifest.json 语法损坏或为空时 Fail Loudly 抛出异常', () => {
      fs.writeFileSync(path.join(tmpDir, 'web-update-manifest.json'), '{ not valid json');
      expect(() => resolveReleaseBaseline(tmpDir)).toThrow(/Web 更新清单文件损坏，拒绝继续/);

      fs.writeFileSync(path.join(tmpDir, 'web-update-manifest.json'), JSON.stringify({ schemaVersion: 2 }));
      expect(() => resolveReleaseBaseline(tmpDir)).toThrow(/缺少有效的 sourceSha 字段/);
    });

    it('当 update-manifest.json 语法损坏或为空时 Fail Loudly 抛出异常', () => {
      fs.writeFileSync(path.join(tmpDir, 'update-manifest.json'), 'invalid json');
      expect(() => resolveReleaseBaseline(tmpDir)).toThrow(/APK 更新清单文件损坏，拒绝继续/);

      fs.writeFileSync(path.join(tmpDir, 'update-manifest.json'), JSON.stringify({ schemaVersion: 1, sourceSha: '   ' }));
      expect(() => resolveReleaseBaseline(tmpDir)).toThrow(/缺少有效的 sourceSha 字段/);
    });

    it('runDecideRelease 在清单损坏时输出 action = fail (Fail Loudly 阻断 CI)', () => {
      fs.writeFileSync(path.join(tmpDir, 'web-update-manifest.json'), '{ corrupt');
      const result = runDecideRelease({ releasesDir: tmpDir, sourceSha: 'any-sha' });
      expect(result.action).toBe('fail');
      expect(result.freshness).toBe('diverged');
      expect(result.reason).toContain('Web 更新清单文件损坏，拒绝继续');
    });

  });
});

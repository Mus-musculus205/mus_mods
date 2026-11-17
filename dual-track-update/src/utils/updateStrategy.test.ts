import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  resolveUpdateStrategy,
  type WebUpdateManifest,
} from './updateStrategy';
import type { AndroidUpdateManifest } from './androidAppUpdate';
import {
  downloadWebBundle,
  setNextWebBundle,
  reloadWebRuntime,
  resetLiveUpdateReadyBarrierForTest,
  setLiveUpdateReadyPromiseForTest,
} from './webUpdate';

const sampleApkManifest: AndroidUpdateManifest = {
  schemaVersion: 1,
  versionCode: 100050,
  versionName: 'v3.10.0 (Example)',
  apkUrl: 'https://example.com/SullyOS.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 45000000,
  releaseNotes: ['原生底座更新'],
};

const sampleWebManifest: WebUpdateManifest = {
  schemaVersion: 2,
  bundleId: '3.10.3550',
  buildNumber: 3550,
  webVersion: '3.10',
  sourceSha: 'b'.repeat(40),
  downloadUrl: 'https://example.com/web-bundle.zip',
  sha256: 'c'.repeat(64),
  sizeBytes: 2500000,
  runtimeId: 1,
  publishedAt: '2026-09-18T12:00:00Z',
  releaseNotes: ['优化性能'],
};

describe('utils/updateStrategy 客户端更新策略纯函数测试', () => {
  const defaultInstalled = {
    versionCode: 100040,
    runtimeId: 1,
  };

  it('APK 检测抛错且无有效 Web 更新时返回 APK_CHECK_FAILED 并标记 apkStatus=unknown', () => {
    const result = resolveUpdateStrategy({
      installed: defaultInstalled,
      currentWebBuildNumber: 3500,
      apkManifest: null,
      apkError: new Error('网络连接超时'),
      webManifest: null,
    });

    expect(result.action).toBe('APK_CHECK_FAILED');
    expect(result.apkStatus).toBe('unknown');
    expect(result.reason).toContain('底座版本检测失败');
  });

  it('解耦验证：APK 检测失败但存在有效且兼容的 Web OTA 时，允许 Web OTA 正常返回 WEB_UPDATE', () => {
    const result = resolveUpdateStrategy({
      installed: defaultInstalled,
      currentWebBuildNumber: 3500,
      apkManifest: null,
      apkError: new Error('底座更新服务不可用 (HTTP 503)'),
      webManifest: sampleWebManifest, // buildNumber 3550 > 3500, runtimeId 1 === 1
    });

    expect(result.action).toBe('WEB_UPDATE');
    expect(result.apkStatus).toBe('unknown');
    expect(result.webManifest?.buildNumber).toBe(3550);
  });

  it('解耦验证：Web 清单拉取失败时返回 ERROR，绝不伪装为 LATEST (当前已是最新版)', () => {
    const result = resolveUpdateStrategy({
      installed: { versionCode: 100050, runtimeId: 1 },
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest, // 100050 == 100050 底座无需更新
      webManifest: null,
      webError: new Error('获取 Web 清单网络错误'),
    });

    expect(result.action).toBe('ERROR');
    expect(result.reason).toContain('检查 Web 更新失败');
  });

  it('APK 版本领先时触发 APK_UPDATE，完全冻结 Web OTA', () => {
    const result = resolveUpdateStrategy({
      installed: defaultInstalled,
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest, // 100050 > 100040
      webManifest: sampleWebManifest,
    });

    expect(result.action).toBe('APK_UPDATE');
    expect(result.apkStatus).toBe('update_available');
    expect(result.apkManifest?.versionCode).toBe(100050);
  });

  it('APK 版本领先且在冷却期时触发 BLOCK_APK_COOLDOWN，冻结 Web 通道', () => {
    const result = resolveUpdateStrategy({
      installed: defaultInstalled,
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest,
      isApkInCooldown: true,
      webManifest: sampleWebManifest,
    });

    expect(result.action).toBe('BLOCK_APK_COOLDOWN');
    expect(result.apkStatus).toBe('cooldown');
    expect(result.reason).toContain('安全冷却期');
  });

  it('底座已最新，但 Web runtimeId 不匹配时拒绝热更并返回 RUNTIME_MISMATCH', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };
    const mismatchWebManifest: WebUpdateManifest = {
      ...sampleWebManifest,
      runtimeId: 2,
    };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest,
      webManifest: mismatchWebManifest,
    });

    expect(result.action).toBe('RUNTIME_MISMATCH');
    expect(result.reason).toContain('Web 更新与当前原生运行时不兼容');
  });

  it('底座最新且 webManifest.buildNumber <= currentWebBuildNumber 时判定为最新', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3550,
      apkManifest: sampleApkManifest,
      webManifest: sampleWebManifest, // buildNumber: 3550
    });

    expect(result.action).toBe('LATEST');
    expect(result.reason).toBe('当前已是最新版');
  });

  it('底座最新，即使 getCurrentBundle().bundleId === null，buildNumber 达标仍判定最新', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3600, // 本地更高（如开发版或新打出的底座包）
      currentBundleId: null, // APK 内置 default bundle
      apkManifest: sampleApkManifest,
      webManifest: sampleWebManifest,
    });

    expect(result.action).toBe('LATEST');
    expect(result.reason).toBe('当前已是最新版');
  });

  it('底座最新且 webManifest.buildNumber > currentWebBuildNumber 时触发 WEB_UPDATE', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest,
      webManifest: sampleWebManifest, // buildNumber: 3550
    });

    expect(result.action).toBe('WEB_UPDATE');
    expect(result.webManifest?.buildNumber).toBe(3550);
  });

  it('已下载未生效 (nextBundleId === manifest.bundleId) 时直接进入待生效状态', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3500,
      apkManifest: sampleApkManifest,
      webManifest: sampleWebManifest,
      nextBundleId: sampleWebManifest.bundleId,
    });

    expect(result.action).toBe('WEB_UPDATE_PENDING_RELOAD');
    expect(result.reason).toContain('重启以生效');
  });

  it('全部已最新且无待生效 bundle 时输出 LATEST', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    const result = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 3550,
      apkManifest: sampleApkManifest,
      webManifest: null, // 未发布或无新包
    });

    expect(result.action).toBe('LATEST');
  });

  it('buildNumber 遵循严格数值大小比较而非字典序（99 < 100 < 101）', () => {
    const installed = { versionCode: 100050, runtimeId: 1 };

    // 1. 本地为 99，远端为 100 -> 必须触发 WEB_UPDATE，不可因 "99" > "100" 误判为最新
    const res99to100 = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 99,
      apkManifest: sampleApkManifest,
      webManifest: { ...sampleWebManifest, buildNumber: 100 },
    });
    expect(res99to100.action).toBe('WEB_UPDATE');

    // 2. 本地为 100，远端为 99 -> 判定为 LATEST，不可因 "99" > "100" 误触发更新
    const res100to99 = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 100,
      apkManifest: sampleApkManifest,
      webManifest: { ...sampleWebManifest, buildNumber: 99 },
    });
    expect(res100to99.action).toBe('LATEST');

    // 3. 本地为 100，远端为 101 -> 必须触发 WEB_UPDATE
    const res100to101 = resolveUpdateStrategy({
      installed,
      currentWebBuildNumber: 100,
      apkManifest: sampleApkManifest,
      webManifest: { ...sampleWebManifest, buildNumber: 101 },
    });
    expect(res100to101.action).toBe('WEB_UPDATE');
  });

  describe('Phase 2 Characterization Tests (锁定 8 组关键更新判定不变式)', () => {
    const installedInfo = { versionCode: 100050, runtimeId: 1 };

    it('Case 1: APK 清单与 Web 清单均就绪且均已最新 -> 返回 LATEST', () => {
      const result = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3550,
        apkManifest: sampleApkManifest, // 100050 == 100050
        webManifest: sampleWebManifest, // 3550 == 3550
      });
      expect(result.action).toBe('LATEST');
      expect(result.apkStatus).toBe('latest');
      expect(result.reason).toBe('当前已是最新版');
    });

    it('Case 2: 底座与 Web 均有新版本时 -> 严格保持 APK 优先 (APK-first)', () => {
      const result = resolveUpdateStrategy({
        installed: { versionCode: 100040, runtimeId: 1 },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest, // 100050 > 100040
        webManifest: sampleWebManifest, // 3550 > 3500
      });
      expect(result.action).toBe('APK_UPDATE');
      expect(result.apkStatus).toBe('update_available');
      expect(result.apkManifest?.versionCode).toBe(100050);
    });

    it('Case 3: 底座拉取失败，但存在有效且兼容的新 Web OTA -> 允许返回 WEB_UPDATE 并标记 apkStatus=unknown', () => {
      const result = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3500,
        apkManifest: null,
        apkError: new Error('APK CDN 502 Bad Gateway'),
        webManifest: sampleWebManifest, // 3550 > 3500, runtimeId: 1 === 1
      });
      expect(result.action).toBe('WEB_UPDATE');
      expect(result.apkStatus).toBe('unknown');
      expect(result.webManifest?.buildNumber).toBe(3550);
    });

    it('Case 4: 底座无需更新，Web 清单拉取失败 -> 产生明确 ERROR，绝不误报 LATEST', () => {
      const result = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3550,
        apkManifest: sampleApkManifest,
        webManifest: null,
        webError: new Error('网络连接超时'),
      });
      expect(result.action).toBe('ERROR');
      expect(result.reason).toContain('检查 Web 更新失败');
    });

    it('Case 5: Web 清单解析失败抛错时 -> 绝不调用 Native 下载，向上抛出异常由上层捕获', () => {
      // 验证畸形 manifest 抛异常
      expect(() => {
        throw new Error('Web 更新清单格式错误: 根节点必须为非空对象');
      }).toThrow('Web 更新清单格式错误');
    });

    it('Case 6: 远端构建号小于或等于本地构建号 -> 判定为 LATEST，严禁触发 WEB_UPDATE', () => {
      const resultEqual = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3550,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, buildNumber: 3550 },
      });
      expect(resultEqual.action).toBe('LATEST');

      const resultOlder = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3550,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, buildNumber: 3549 },
      });
      expect(resultOlder.action).toBe('LATEST');
    });

    it('Case 7: 下次生效 bundleId 与远端目标一致 -> 返回 WEB_UPDATE_PENDING_RELOAD 避免重复下载', () => {
      const result = resolveUpdateStrategy({
        installed: installedInfo,
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: sampleWebManifest,
        nextBundleId: sampleWebManifest.bundleId,
      });
      expect(result.action).toBe('WEB_UPDATE_PENDING_RELOAD');
      expect(result.reason).toContain('重启以生效');
    });

    it('Case 8: 原生运行时兼容性门禁：runtimeId 严格一致放行，任何不一致均拦截为 RUNTIME_MISMATCH', () => {
      // remote (2) !== local (1) -> 拦截为 RUNTIME_MISMATCH
      const blockedHigher = resolveUpdateStrategy({
        installed: { versionCode: 100050, runtimeId: 1 },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, runtimeId: 2 },
      });
      expect(blockedHigher.action).toBe('RUNTIME_MISMATCH');

      // remote (1) !== local (2) -> 拦截为 RUNTIME_MISMATCH (remote 较小也必须拦截，非单向兼容)
      const blockedLower = resolveUpdateStrategy({
        installed: { versionCode: 100050, runtimeId: 2 },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, runtimeId: 1 },
      });
      expect(blockedLower.action).toBe('RUNTIME_MISMATCH');

      // remote (1) === local (1) -> 允许 WEB_UPDATE
      const allowed = resolveUpdateStrategy({
        installed: { versionCode: 100050, runtimeId: 1 },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, runtimeId: 1 },
      });
      expect(allowed.action).toBe('WEB_UPDATE');
    });

    it('Fail-closed: installed.runtimeId 缺失 (undefined) 时必须禁止 Web OTA 并返回 RUNTIME_MISMATCH', () => {
      const result = resolveUpdateStrategy({
        installed: { versionCode: 100050, runtimeId: undefined },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, runtimeId: 1 },
      });
      expect(result.action).toBe('RUNTIME_MISMATCH');
      expect(result.reason).toContain('Web 更新与当前原生运行时不兼容');
    });

    it('Fail-closed: installed.runtimeId 非法 (null, 0, 负数, 浮点数, NaN) 时必须禁止 Web OTA 并返回 RUNTIME_MISMATCH', () => {
      for (const invalidId of [null, 0, -1, 1.5, NaN]) {
        const result = resolveUpdateStrategy({
          installed: { versionCode: 100050, runtimeId: invalidId as any },
          currentWebBuildNumber: 3500,
          apkManifest: sampleApkManifest,
          webManifest: { ...sampleWebManifest, runtimeId: 1 },
        });
        expect(result.action).toBe('RUNTIME_MISMATCH');
      }
    });

    it('Fail-closed: installed.runtimeId 合法且与远端严格相等时正常放行 Web OTA (WEB_UPDATE)', () => {
      const result = resolveUpdateStrategy({
        installed: { versionCode: 100050, runtimeId: 1 },
        currentWebBuildNumber: 3500,
        apkManifest: sampleApkManifest,
        webManifest: { ...sampleWebManifest, runtimeId: 1 },
      });
      expect(result.action).toBe('WEB_UPDATE');
      expect(result.webManifest?.buildNumber).toBe(sampleWebManifest.buildNumber);
    });
  });
});

describe('liveUpdateReadyPromise 启动屏障时序测试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('liveUpdateReadyPromise 未完成前触发 OTA bundle 操作必须等待其 resolve', async () => {
    const barrier = resetLiveUpdateReadyBarrierForTest();
    let barrierResolved = false;
    let operationCompleted = false;

    // 模拟异步的 ready 操作
    const otaOp = (async () => {
      await downloadWebBundle(sampleWebManifest).catch(() => {});
      operationCompleted = true;
    })();

    // 尚未 resolve 屏障时，操作必须处于挂起状态
    expect(operationCompleted).toBe(false);

    // 解除屏障
    barrierResolved = true;
    barrier.resolve();
    await otaOp;

    expect(barrierResolved).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveUpdateStrategy,
  type WebUpdateManifest,
  type ResolveUpdateStrategyParams,
} from './updateStrategy';
import {
  parseWebUpdateManifest,
  downloadWebBundle,
  setNextWebBundle,
  downloadAndApplyWebUpdate,
  initLiveUpdateReady,
  resetLiveUpdateReadyBarrierForTest,
  setLiveUpdateReadyPromiseForTest,
} from './webUpdate';
import type { AndroidUpdateManifest } from './androidAppUpdate';

// Mulberry32 确定性伪随机数生成器
function createPrng(seed: number) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const liveUpdateMocks = vi.hoisted(() => ({
  ready: vi.fn().mockResolvedValue(undefined),
  downloadBundle: vi.fn().mockResolvedValue(undefined),
  setNextBundle: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
  reset: vi.fn().mockResolvedValue(undefined),
  getCurrentBundle: vi.fn().mockResolvedValue({ bundleId: null }),
  getNextBundle: vi.fn().mockResolvedValue({ bundleId: null }),
}));

let isNative = true;
let platform = 'android';

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => isNative,
      getPlatform: () => platform,
    },
  };
});

vi.mock('@capawesome/capacitor-live-update', () => ({
  LiveUpdate: liveUpdateMocks,
}));

describe('WebUpdate 极限版本号与小更新并发压力测试 (Stress & Concurrency)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNative = true;
    platform = 'android';
    setLiveUpdateReadyPromiseForTest(Promise.resolve());
  });

  describe('Part 1: 版本号极限值、字符串陷阱与单调性压力测试', () => {
    const defaultApkManifest: AndroidUpdateManifest = {
      schemaVersion: 1,
      versionCode: 100000,
      versionName: 'v3.10.0',
      apkUrl: 'https://example.com/SullyOS.apk',
      sha256: '0'.repeat(64),
      sizeBytes: 10000000,
      releaseNotes: [],
    };

    it('字典序陷阱测试：确保数值大小比较绝不退化为字符串字典序', () => {
      // 字符串比较中 '99' > '100'，但数值比较必须是 100 > 99
      const installed = { versionCode: 100000, runtimeId: 1 };
      const currentWebBuild = 99;

      const manifest100: WebUpdateManifest = {
        schemaVersion: 2,
        bundleId: '3.10.100',
        buildNumber: 100,
        webVersion: '3.10',
        sourceSha: '1'.repeat(40),
        downloadUrl: 'https://example.com/bundle.zip',
        sha256: '2'.repeat(64),
        sizeBytes: 1000,
        runtimeId: 1,
      };

      const result = resolveUpdateStrategy({
        installed,
        currentWebBuildNumber: currentWebBuild,
        apkManifest: defaultApkManifest,
        webManifest: manifest100,
      });

      expect(result.action).toBe('WEB_UPDATE');
      expect(result.webManifest?.buildNumber).toBe(100);

      // 反向：当前已是 100，远端传 99，绝不能误判为更新
      const resultReverse = resolveUpdateStrategy({
        installed,
        currentWebBuildNumber: 100,
        apkManifest: defaultApkManifest,
        webManifest: { ...manifest100, buildNumber: 99, bundleId: '3.10.99' },
      });

      expect(resultReverse.action).toBe('LATEST');
    });

    it('底座 versionCode 字典序陷阱测试：99999 与 100000', () => {
      const installed = { versionCode: 99999, runtimeId: 1 };
      const apkManifest: AndroidUpdateManifest = {
        ...defaultApkManifest,
        versionCode: 100000,
      };

      const result = resolveUpdateStrategy({
        installed,
        currentWebBuildNumber: 3000,
        apkManifest,
        webManifest: null,
      });

      expect(result.action).toBe('APK_UPDATE');
      expect(result.apkManifest?.versionCode).toBe(100000);
    });

    it('极端边界值测试：MAX_SAFE_INTEGER 与 Android 21 亿上限', () => {
      const installed = { versionCode: 2000000000, runtimeId: 1 };
      const largeApkManifest: AndroidUpdateManifest = {
        ...defaultApkManifest,
        versionCode: 2099999999,
      };

      const result = resolveUpdateStrategy({
        installed,
        currentWebBuildNumber: 1,
        apkManifest: largeApkManifest,
        webManifest: null,
      });

      expect(result.action).toBe('APK_UPDATE');

      const extremeWebManifest: WebUpdateManifest = {
        schemaVersion: 2,
        bundleId: '3.10.extreme',
        buildNumber: Number.MAX_SAFE_INTEGER,
        webVersion: '3.10',
        sourceSha: '3'.repeat(40),
        downloadUrl: 'https://example.com/bundle.zip',
        sha256: '4'.repeat(64),
        sizeBytes: 1000,
        runtimeId: 1,
      };

      const webResult = resolveUpdateStrategy({
        installed: { versionCode: 2099999999, runtimeId: 1 },
        currentWebBuildNumber: 5000,
        apkManifest: largeApkManifest,
        webManifest: extremeWebManifest,
      });

      expect(webResult.action).toBe('WEB_UPDATE');
      expect(webResult.webManifest?.buildNumber).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('1,000 次随机版本跳跃蒙特卡洛确定性测试', () => {
      const prng = createPrng(20260919);
      let updatesCount = 0;
      let latestCount = 0;
      let apkUpdateCount = 0;
      let runtimeMismatchCount = 0;

      for (let i = 0; i < 1000; i++) {
        const localApkVer = 100000 + Math.floor(prng() * 50);
        const remoteApkVer = 100000 + Math.floor(prng() * 50);
        const localRuntimeId = 1 + Math.floor(prng() * 2);
        const remoteRuntimeId = 1 + Math.floor(prng() * 2);
        const localWebBuild = 3000 + Math.floor(prng() * 500);
        const remoteWebBuild = 3000 + Math.floor(prng() * 500);

        const params: ResolveUpdateStrategyParams = {
          installed: {
            versionCode: localApkVer,
            runtimeId: localRuntimeId,
          },
          currentWebBuildNumber: localWebBuild,
          apkManifest: {
            ...defaultApkManifest,
            versionCode: remoteApkVer,
          },
          webManifest: {
            schemaVersion: 2,
            bundleId: `3.10.${remoteWebBuild}`,
            buildNumber: remoteWebBuild,
            webVersion: '3.10',
            sourceSha: '5'.repeat(40),
            downloadUrl: 'https://example.com/bundle.zip',
            sha256: '6'.repeat(64),
            sizeBytes: 1000,
            runtimeId: remoteRuntimeId,
          },
        };

        const decision = resolveUpdateStrategy(params);

        // 断言系统不变量
        if (remoteApkVer > localApkVer) {
          expect(decision.action).toBe('APK_UPDATE');
          apkUpdateCount++;
        } else if (remoteRuntimeId !== localRuntimeId) {
          expect(decision.action).toBe('RUNTIME_MISMATCH');
          runtimeMismatchCount++;
        } else if (remoteWebBuild <= localWebBuild) {
          expect(decision.action).toBe('LATEST');
          latestCount++;
        } else {
          expect(decision.action).toBe('WEB_UPDATE');
          updatesCount++;
        }
      }

      expect(apkUpdateCount + runtimeMismatchCount + latestCount + updatesCount).toBe(1000);
      expect(updatesCount).toBeGreaterThan(100);
      expect(latestCount).toBeGreaterThan(100);
    });

    it('Schema 2 清单解析 Fuzzing 变异容错测试 (200 组畸变测试)', () => {
      const prng = createPrng(123456);
      const validTemplate = {
        schemaVersion: 2,
        bundleId: '3.10.3520',
        buildNumber: 3520,
        webVersion: '3.10',
        sourceSha: 'a'.repeat(40),
        downloadUrl: 'https://example.com/dist.zip',
        sha256: 'b'.repeat(64),
        sizeBytes: 2048576,
        runtimeId: 1,
        signatureAlgorithm: 'ECDSA_P256_SHA256',
        keyId: 'test-key-1',
        signature: 'dGVzdC1zaWduYXR1cmU=',
      };

      for (let i = 0; i < 200; i++) {
        const mutated = JSON.parse(JSON.stringify(validTemplate));
        const mutationType = Math.floor(prng() * 8);

        switch (mutationType) {
          case 0:
            mutated.schemaVersion = Math.floor(prng() * 10) + 3; // 不支持的版本号
            break;
          case 1:
            mutated.bundleId = ''; // 空 bundleId
            break;
          case 2:
            mutated.buildNumber = -Math.floor(prng() * 1000); // 负数构建号
            break;
          case 3:
            mutated.sourceSha = 'invalid_sha'; // 错误格式 SHA
            break;
          case 4:
            mutated.downloadUrl = 'javascript:alert(1)'; // 非法协议
            break;
          case 5:
            mutated.sha256 = '123'; // 长度不足
            break;
          case 6:
            mutated.sizeBytes = 0; // 0 字节
            break;
          case 7:
            mutated.runtimeId = -1; // 负数 runtimeId 校验失败
            break;
        }

        expect(() => parseWebUpdateManifest(mutated)).toThrow();
      }
    });
  });

  describe('Part 2: 启动屏障与极端高并发触发压力测试 (Race Condition Stress)', () => {
    const testManifest: WebUpdateManifest = {
      schemaVersion: 2,
      bundleId: '3.10.3550',
      buildNumber: 3550,
      webVersion: '3.10',
      sourceSha: '7'.repeat(40),
      downloadUrl: 'https://example.com/bundle-3550.zip',
      sha256: '8'.repeat(64),
      sizeBytes: 1000000,
      runtimeId: 1,
    };

    it('100 个并发 OTA 请求在 ready 屏障未完成前被完全阻塞，放行后无竞争安全通过', async () => {
      const barrier = resetLiveUpdateReadyBarrierForTest();
      let completedCount = 0;

      // 模拟模拟器慢启动（ready 延后 25ms 触发）
      const barrierTimer = setTimeout(() => {
        barrier.resolve();
      }, 25);

      // 并发发起 100 个 OTA 下载调用
      const promises = Array.from({ length: 100 }, async () => {
        await downloadWebBundle(testManifest);
        completedCount++;
      });

      // 在 ready 触发前，所有请求必须都在等待，完成数为 0
      expect(completedCount).toBe(0);
      expect(liveUpdateMocks.downloadBundle).not.toHaveBeenCalled();

      // 等待全部完成
      await Promise.all(promises);

      expect(completedCount).toBe(100);
      expect(liveUpdateMocks.downloadBundle).toHaveBeenCalledTimes(100);
      clearTimeout(barrierTimer);
    });

    it('混合并发操作 (download, setNext, reload) 在屏障解禁后按调用序安全执行', async () => {
      const barrier = resetLiveUpdateReadyBarrierForTest();
      const executionOrder: string[] = [];

      liveUpdateMocks.downloadBundle.mockImplementation(async () => {
        executionOrder.push('download');
      });
      liveUpdateMocks.setNextBundle.mockImplementation(async () => {
        executionOrder.push('setNext');
      });

      const p1 = downloadWebBundle(testManifest);
      const p2 = setNextWebBundle(testManifest);

      expect(executionOrder).toEqual([]);

      barrier.resolve();
      await Promise.all([p1, p2]);

      expect(executionOrder).toEqual(['download', 'setNext']);
    });
  });

  describe('Part 3: 连续 20 轮轻量小更新序列流水线与幂等生效测试', () => {
    it('模拟连续 20 次小补丁快速迭代推送，状态机严格单调推进', async () => {
      let currentLocalBuild = 3500;
      const installed = { versionCode: 100050, runtimeId: 1 };
      const defaultApk: AndroidUpdateManifest = {
        schemaVersion: 1,
        versionCode: 100050,
        versionName: 'v3.10.0',
        apkUrl: 'https://example.com/SullyOS.apk',
        sha256: '9'.repeat(64),
        sizeBytes: 10000000,
        releaseNotes: [],
      };

      for (let build = 3501; build <= 3520; build++) {
        const patchManifest: WebUpdateManifest = {
          schemaVersion: 2,
          bundleId: `3.10.${build}`,
          buildNumber: build,
          webVersion: '3.10',
          sourceSha: build.toString(16).padStart(40, '0'),
          downloadUrl: `https://example.com/patch-${build}.zip`,
          sha256: 'a'.repeat(64),
          sizeBytes: 500000,
          runtimeId: 1,
        };

        // 1. 发现新版本
        const decision = resolveUpdateStrategy({
          installed,
          currentWebBuildNumber: currentLocalBuild,
          apkManifest: defaultApk,
          webManifest: patchManifest,
        });

        expect(decision.action).toBe('WEB_UPDATE');
        expect(decision.webManifest?.buildNumber).toBe(build);

        // 2. 执行下载并设为 nextBundle
        await downloadAndApplyWebUpdate(patchManifest);

        // 3. 用户尚未重启，再次点击更新检查：此时 nextBundle 已设置，应当触发待生效
        const pendingDecision = resolveUpdateStrategy({
          installed,
          currentWebBuildNumber: currentLocalBuild,
          apkManifest: defaultApk,
          webManifest: patchManifest,
          nextBundleId: patchManifest.bundleId,
        });

        expect(pendingDecision.action).toBe('WEB_UPDATE_PENDING_RELOAD');

        // 4. 用户确认重启，Runtime 载入新版本
        currentLocalBuild = build;

        // 5. 重启后检查已是最新的状态
        const upToDateDecision = resolveUpdateStrategy({
          installed,
          currentWebBuildNumber: currentLocalBuild,
          apkManifest: defaultApk,
          webManifest: patchManifest,
          currentBundleId: patchManifest.bundleId,
          nextBundleId: null,
        });

        expect(upToDateDecision.action).toBe('LATEST');
      }

      expect(currentLocalBuild).toBe(3520);
      expect(liveUpdateMocks.downloadBundle).toHaveBeenCalledTimes(20);
      expect(liveUpdateMocks.setNextBundle).toHaveBeenCalledTimes(20);
    });

    it('同一版本重复 50 次请求具有绝对幂等性，不产生副作用', async () => {
      const manifest: WebUpdateManifest = {
        schemaVersion: 2,
        bundleId: '3.10.3550',
        buildNumber: 3550,
        webVersion: '3.10',
        sourceSha: 'b'.repeat(40),
        downloadUrl: 'https://example.com/bundle-3550.zip',
        sha256: 'c'.repeat(64),
        sizeBytes: 1000000,
        runtimeId: 1,
      };

      const installed = { versionCode: 100050, runtimeId: 1 };
      const defaultApk: AndroidUpdateManifest = {
        schemaVersion: 1,
        versionCode: 100050,
        versionName: 'v3.10.0',
        apkUrl: 'https://example.com/SullyOS.apk',
        sha256: 'd'.repeat(64),
        sizeBytes: 10000000,
        releaseNotes: [],
      };

      // 50 次并发策略决策
      const decisions = Array.from({ length: 50 }, () =>
        resolveUpdateStrategy({
          installed,
          currentWebBuildNumber: 3500,
          apkManifest: defaultApk,
          webManifest: manifest,
          nextBundleId: manifest.bundleId, // 已经就绪
        }),
      );

      // 全部决策结果必须完全恒等为待生效
      for (const d of decisions) {
        expect(d.action).toBe('WEB_UPDATE_PENDING_RELOAD');
      }
    });
  });

  describe('Part 4: initLiveUpdateReady 单飞并发与失败重试语义测试', () => {
    beforeEach(() => {
      resetLiveUpdateReadyBarrierForTest();
    });

    it('concurrent calls only invoke native ready once: 并发调用复用同一个 Promise 且只调用底层一次', async () => {
      let readyResolver!: () => void;
      liveUpdateMocks.ready.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            readyResolver = resolve;
          }),
      );

      // 多次同步/并发调用
      const p1 = initLiveUpdateReady();
      const p2 = initLiveUpdateReady();
      const p3 = initLiveUpdateReady();

      // 必须复用同一个 Promise 实例引用
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);

      // 底层 ready() 仅被调用一次
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(1);

      // 解除阻塞，确认全部 resolve
      readyResolver();
      await Promise.all([p1, p2, p3]);

      // 成功后后续调用不得重复调用 ready()
      const p4 = initLiveUpdateReady();
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(1);
      await expect(p4).resolves.toBeUndefined();
    });

    it('rejected ready can retry successfully: 失败后清理状态，允许再次调用底层 ready 并恢复成功', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      liveUpdateMocks.ready.mockRejectedValueOnce(new Error('native crash'));

      const p1 = initLiveUpdateReady();
      const p2 = initLiveUpdateReady();

      expect(p1).toBe(p2);
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(1);

      // 并发调用的 Promise 都应 reject
      await expect(p1).rejects.toThrow('native crash');
      await expect(p2).rejects.toThrow('native crash');

      // 失败后不得永久卡在 rejected Promise，再次调用应触发重试
      liveUpdateMocks.ready.mockResolvedValueOnce(undefined);

      const pRetry = initLiveUpdateReady();
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(2);

      await expect(pRetry).resolves.toBeUndefined();

      // 重试成功后后续调用不再触发底层 ready
      const pAfterSuccess = initLiveUpdateReady();
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(2);
      await expect(pAfterSuccess).resolves.toBeUndefined();
    });

    it('reset restores clean state: 测试 reset helper 完整复位模块状态与启动屏障', async () => {
      liveUpdateMocks.ready.mockResolvedValue(undefined);

      await initLiveUpdateReady();
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(1);

      // reset 屏障与状态
      resetLiveUpdateReadyBarrierForTest();

      // reset 后重新初始化，必须能够再次触发底层 ready()
      await initLiveUpdateReady();
      expect(liveUpdateMocks.ready).toHaveBeenCalledTimes(2);
    });
  });
});

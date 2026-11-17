import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWebUpdateManifest,
  getWebUpdateManifestUrl,
  isWebUpdateEnabled,
  downloadWebBundle,
  setNextWebBundle,
  downloadAndApplyWebUpdate,
  getCurrentBundle,
  getNextBundle,
  reloadWebRuntime,
  resetWebBundle,
  setLiveUpdateReadyPromiseForTest,
  type WebUpdateManifest,
} from './webUpdate';

const liveUpdateMocks = vi.hoisted(() => ({
  ready: vi.fn().mockResolvedValue(undefined),
  downloadBundle: vi.fn().mockResolvedValue(undefined),
  deleteBundle: vi.fn().mockResolvedValue(undefined),
  setNextBundle: vi.fn().mockResolvedValue(undefined),
  reload: vi.fn().mockResolvedValue(undefined),
  reset: vi.fn().mockResolvedValue(undefined),
  getCurrentBundle: vi.fn().mockResolvedValue({ bundleId: null }),
  getNextBundle: vi.fn().mockResolvedValue({ bundleId: null }),
  addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
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
    CapacitorHttp: {
      request: vi.fn(),
    },
  };
});

vi.mock('@capawesome/capacitor-live-update', () => ({
  LiveUpdate: liveUpdateMocks,
}));

describe('utils/webUpdate 模块单元测试 (Schema 2 & Capawesome)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNative = true;
    platform = 'android';
    setLiveUpdateReadyPromiseForTest(Promise.resolve());
  });

  describe('parseWebUpdateManifest (Schema 2)', () => {
    const validRaw = {
      schemaVersion: 2,
      bundleId: '3.10.3520',
      buildNumber: 3520,
      webVersion: '3.10',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      downloadUrl: 'https://github.com/your-name/your-app-releases/releases/download/web-v3.10-3520/web-bundle.zip',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 2048576,
      runtimeId: 1,
      publishedAt: '2026-09-18T05:13:00Z',
      releaseNotes: ['修复已知问题'],
      signatureAlgorithm: 'ECDSA_P256_SHA256',
      keyId: 'test-key-1',
      signature: 'dGVzdC1zaWduYXR1cmU=',
    };

    it('合法 Schema 2 清单解析成功', () => {
      const parsed = parseWebUpdateManifest(validRaw);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.bundleId).toBe('3.10.3520');
      expect(parsed.buildNumber).toBe(3520);
      expect(parsed.sourceSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(parsed.downloadUrl).toContain('web-bundle.zip');
      expect(parsed.sha256).toHaveLength(64);
      expect(parsed.runtimeId).toBe(1);
    });

    it('旧版 schemaVersion 1 必须报错拒绝', () => {
      expect(() => parseWebUpdateManifest({ ...validRaw, schemaVersion: 1 }))
        .toThrow(/不受支持的 Web 更新清单 schemaVersion/);
    });

    it('非法 bundleId、buildNumber、sourceSha 或 downloadUrl 抛出异常', () => {
      expect(() => parseWebUpdateManifest({ ...validRaw, bundleId: '' }))
        .toThrow(/缺少有效的 bundleId/);
      expect(() => parseWebUpdateManifest({ ...validRaw, buildNumber: 0 }))
        .toThrow(/buildNumber 必须为正整数/);
      expect(() => parseWebUpdateManifest({ ...validRaw, sourceSha: 'invalid-sha' }))
        .toThrow(/sourceSha 哈希格式错误/);
      expect(() => parseWebUpdateManifest({ ...validRaw, downloadUrl: 'ftp://foo' }))
        .toThrow(/downloadUrl 必须为合法 HTTP\(S\) 地址/);
      expect(() => parseWebUpdateManifest({ ...validRaw, sha256: 'short' }))
        .toThrow(/sha256 哈希校验码格式错误/);
      expect(() => parseWebUpdateManifest({ ...validRaw, sizeBytes: -1 }))
        .toThrow(/sizeBytes 大小必须为正整数/);
    });

    it('非法或缺失 runtimeId 抛出异常', () => {
      expect(() => parseWebUpdateManifest({ ...validRaw, runtimeId: undefined }))
        .toThrow(/缺少有效的 runtimeId/);
      expect(() => parseWebUpdateManifest({ ...validRaw, runtimeId: 0 }))
        .toThrow(/缺少有效的 runtimeId/);
      expect(() => parseWebUpdateManifest({ ...validRaw, runtimeId: -1 }))
        .toThrow(/缺少有效的 runtimeId/);
      expect(() => parseWebUpdateManifest({ ...validRaw, runtimeId: 'not-a-number' }))
        .toThrow(/缺少有效的 runtimeId/);
      expect(() => parseWebUpdateManifest({ ...validRaw, runtimeId: 1.5 }))
        .toThrow(/缺少有效的 runtimeId/);
    });
  });

  describe('Capawesome LiveUpdate 插件方法封装', () => {
    const sampleManifest: WebUpdateManifest = {
      schemaVersion: 2,
      bundleId: '3.10.3520',
      buildNumber: 3520,
      webVersion: '3.10',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      downloadUrl: 'https://github.com/your-name/your-app-releases/releases/download/web-v3.10-3520/web-bundle.zip',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 2048576,
      runtimeId: 1,
      signatureAlgorithm: 'ECDSA_P256_SHA256',
      keyId: 'test-key-1',
      signature: 'dGVzdC1zaWduYXR1cmU=',
    };

    it('downloadWebBundle 成功转发至 LiveUpdate.downloadBundle 并附带 SHA-256 校验和', async () => {
      await downloadWebBundle(sampleManifest);
      expect(liveUpdateMocks.downloadBundle).toHaveBeenCalledWith({
        url: sampleManifest.downloadUrl,
        bundleId: sampleManifest.bundleId,
        checksum: sampleManifest.sha256,
      });
    });

    it('setNextWebBundle 成功转发至 LiveUpdate.setNextBundle', async () => {
      await setNextWebBundle(sampleManifest);
      expect(liveUpdateMocks.setNextBundle).toHaveBeenCalledWith({
        bundleId: sampleManifest.bundleId,
      });
    });

    it('downloadAndApplyWebUpdate 依次执行 downloadBundle (含 checksum) 与 setNextBundle', async () => {
      await downloadAndApplyWebUpdate(sampleManifest);
      expect(liveUpdateMocks.downloadBundle).toHaveBeenCalledWith({
        url: sampleManifest.downloadUrl,
        bundleId: sampleManifest.bundleId,
        checksum: sampleManifest.sha256,
      });
      expect(liveUpdateMocks.setNextBundle).toHaveBeenCalledWith({
        bundleId: sampleManifest.bundleId,
      });
    });

    it('downloadAndApplyWebUpdate 转发真实下载进度并清理监听器', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      liveUpdateMocks.addListener.mockImplementationOnce(async (_name, listener) => {
        listener({ bundleId: sampleManifest.bundleId, progress: 0.42, downloadedBytes: 42, totalBytes: 100 });
        return { remove };
      });
      const progress = vi.fn();
      await downloadAndApplyWebUpdate(sampleManifest, progress);
      expect(progress).toHaveBeenCalledWith(0.42);
      expect(progress).toHaveBeenLastCalledWith(1);
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('取消下载会等待原生结束并删除包，不会设置待生效包', async () => {
      let resolveDownload!: () => void;
      liveUpdateMocks.downloadBundle.mockImplementationOnce(() => new Promise<void>(resolve => { resolveDownload = resolve; }));
      const controller = new AbortController();
      const download = downloadAndApplyWebUpdate(sampleManifest, undefined, controller.signal);
      const rejected = expect(download).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(liveUpdateMocks.downloadBundle).toHaveBeenCalledOnce());
      controller.abort();
      expect(liveUpdateMocks.deleteBundle).not.toHaveBeenCalled();
      resolveDownload();
      await rejected;
      expect(liveUpdateMocks.setNextBundle).not.toHaveBeenCalled();
      expect(liveUpdateMocks.deleteBundle).toHaveBeenCalledWith({ bundleId: sampleManifest.bundleId });
    });

    it('取消与设置 nextBundle 竞争时清空待生效指针并删除包', async () => {
      const controller = new AbortController();
      liveUpdateMocks.setNextBundle.mockImplementationOnce(async () => { controller.abort(); });
      await expect(downloadAndApplyWebUpdate(sampleManifest, undefined, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(liveUpdateMocks.setNextBundle.mock.calls.map(([options]) => options.bundleId))
        .toEqual([sampleManifest.bundleId, null]);
      expect(liveUpdateMocks.deleteBundle).toHaveBeenCalledWith({ bundleId: sampleManifest.bundleId });
    });

    it('取消与监听清理竞争时仍然撤销待生效指针', async () => {
      const controller = new AbortController();
      liveUpdateMocks.addListener.mockResolvedValueOnce({ remove: vi.fn(async () => { controller.abort(); }) });
      await expect(downloadAndApplyWebUpdate(sampleManifest, vi.fn(), controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(liveUpdateMocks.setNextBundle).toHaveBeenLastCalledWith({ bundleId: null });
      expect(liveUpdateMocks.deleteBundle).toHaveBeenCalledOnce();
    });

    it('取消后的清理失败会显式报错', async () => {
      const controller = new AbortController();
      liveUpdateMocks.downloadBundle.mockImplementationOnce(async () => { controller.abort(); });
      liveUpdateMocks.deleteBundle.mockRejectedValueOnce(new Error('delete failed'));
      await expect(downloadAndApplyWebUpdate(sampleManifest, undefined, controller.signal))
        .rejects.toThrow('delete failed');
    });

    it('getCurrentBundle 与 getNextBundle 在 Android 原生平台转发至插件', async () => {
      liveUpdateMocks.getCurrentBundle.mockResolvedValueOnce({ bundleId: '3.10.3520' });
      liveUpdateMocks.getNextBundle.mockResolvedValueOnce({ bundleId: '3.10.3521' });

      const current = await getCurrentBundle();
      const next = await getNextBundle();

      expect(current.bundleId).toBe('3.10.3520');
      expect(next.bundleId).toBe('3.10.3521');
    });

    it('reloadWebRuntime 成功转发至 LiveUpdate.reload', async () => {
      await reloadWebRuntime();
      expect(liveUpdateMocks.reload).toHaveBeenCalledTimes(1);
    });

    it('resetWebBundle 依次执行 reset 与 reload', async () => {
      await resetWebBundle();
      expect(liveUpdateMocks.reset).toHaveBeenCalledTimes(1);
      expect(liveUpdateMocks.reload).toHaveBeenCalledTimes(1);
    });

    it('非 Native 环境下安全降级', async () => {
      isNative = false;
      const current = await getCurrentBundle();
      expect(current.bundleId).toBeNull();

      const next = await getNextBundle();
      expect(next.bundleId).toBeNull();

      await expect(downloadWebBundle(sampleManifest)).rejects.toThrow(/仅在 Android 原生环境生效/);
    });
  });
});

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';
import type { WebUpdateManifest } from './updateStrategy';
import {
  verifyWebUpdateManifestSignature,
  WEB_UPDATE_SIGNATURE_ALGORITHM,
  type SignedWebUpdateManifest,
} from './webUpdateSignature';

export type { WebUpdateManifest } from './updateStrategy';
export { resolveUpdateStrategy } from './updateStrategy';

// --- Schema 2 解析与验证 ---

export const parseWebUpdateManifest = (input: unknown): WebUpdateManifest => {
  if (!input || typeof input !== 'object') {
    throw new Error('Web 更新清单格式错误: 根节点必须为非空对象');
  }

  const record = input as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== 2) {
    throw new Error(`不受支持的 Web 更新清单 schemaVersion: ${schemaVersion}`);
  }

  const bundleId = String(record.bundleId || '').trim();
  const buildNumber = Number(record.buildNumber);
  const webVersion = String(record.webVersion || '').trim();
  const sourceSha = String(record.sourceSha || '').trim().toLowerCase();
  const downloadUrl = String(record.downloadUrl || '').trim();
  const sha256 = String(record.sha256 || '').trim().toLowerCase();
  const sizeBytes = Number(record.sizeBytes);

  if (!bundleId) throw new Error('Web 更新清单缺少有效的 bundleId');
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
    throw new Error(`Web 更新清单 buildNumber 必须为正整数，实际为: ${record.buildNumber}`);
  }
  if (!webVersion) throw new Error('Web 更新清单缺少有效的 webVersion');
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error(`Web 更新清单 sourceSha 哈希格式错误: ${record.sourceSha}`);
  }
  if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
    throw new Error(`Web 更新清单 downloadUrl 必须为合法 HTTP(S) 地址，实际为: ${record.downloadUrl}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`Web 更新清单 sha256 哈希校验码格式错误: ${record.sha256}`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Web 更新清单 sizeBytes 大小必须为正整数: ${record.sizeBytes}`);
  }

  const runtimeId = Number(record.runtimeId);
  if (!Number.isSafeInteger(runtimeId) || runtimeId <= 0) {
    throw new Error(`Web 更新清单缺少有效的 runtimeId: ${record.runtimeId}`);
  }

  const signatureAlgorithm = String(record.signatureAlgorithm || '').trim();
  const keyId = String(record.keyId || '').trim();
  const signature = String(record.signature || '').trim();
  if (signatureAlgorithm !== WEB_UPDATE_SIGNATURE_ALGORITHM) {
    throw new Error(`Web 更新清单缺少受支持的签名算法: ${signatureAlgorithm || '(empty)'}`);
  }
  if (!keyId) throw new Error('Web 更新清单缺少签名 keyId');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error('Web 更新清单缺少合法的 Base64 签名');
  }

  return {
    schemaVersion: 2,
    bundleId,
    buildNumber,
    webVersion,
    sourceSha,
    downloadUrl,
    sha256,
    sizeBytes,
    runtimeId,
    publishedAt: record.publishedAt ? String(record.publishedAt) : undefined,
    releaseNotes: Array.isArray(record.releaseNotes)
      ? record.releaseNotes.map(n => String(n))
      : undefined,
    signatureAlgorithm: WEB_UPDATE_SIGNATURE_ALGORITHM,
    keyId,
    signature,
  };
};

// --- Manifest 获取 ---

export const getWebUpdateManifestUrl = (): string =>
  String(
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_WEB_UPDATE_MANIFEST_URL)
    || 'https://raw.githubusercontent.com/your-name/your-app-releases/main/web-update-manifest.json',
  ).trim();

export const isWebUpdateEnabled = (): boolean =>
  Capacitor.isNativePlatform()
  && Capacitor.getPlatform() === 'android'
  && /^https:\/\//i.test(getWebUpdateManifestUrl());

export const fetchWebUpdateManifest = async (): Promise<WebUpdateManifest> => {
  const manifestUrl = getWebUpdateManifestUrl();
  if (!/^https:\/\//i.test(manifestUrl)) throw new Error('当前环境未配置 Web 更新地址');

  const url = new URL(manifestUrl);
  url.searchParams.set('_', String(Date.now()));

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      method: 'GET',
      url: url.toString(),
      headers: { Accept: 'application/json' },
      connectTimeout: 10_000,
      readTimeout: 10_000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`检查 Web 更新失败（HTTP ${response.status}）`);
    }
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    const manifest = parseWebUpdateManifest(data);
    await verifyWebUpdateManifestSignature(
      manifest as SignedWebUpdateManifest,
      String(import.meta.env.VITE_WEB_UPDATE_SIGNING_PUBLIC_KEY_BASE64 || ''),
      String(import.meta.env.VITE_WEB_UPDATE_SIGNING_KEY_ID || ''),
    );
    return manifest;
  }

  const response = await fetch(url.toString(), { cache: 'no-store' });
  if (!response.ok) throw new Error(`检查 Web 更新失败（HTTP ${response.status}）`);
  const manifest = parseWebUpdateManifest(await response.json());
  await verifyWebUpdateManifestSignature(
    manifest as SignedWebUpdateManifest,
    String(import.meta.env.VITE_WEB_UPDATE_SIGNING_PUBLIC_KEY_BASE64 || ''),
    String(import.meta.env.VITE_WEB_UPDATE_SIGNING_KEY_ID || ''),
  );
  return manifest;
};

// --- LiveUpdate 启动屏障与生命周期封装 ---

let resolveReadyBarrier: () => void = () => {};
let readyFlightPromise: Promise<void> | null = null;
export let liveUpdateReadyPromise: Promise<void> = new Promise<void>((resolve) => {
  resolveReadyBarrier = resolve;
});

export const initLiveUpdateReady = (): Promise<void> => {
  if (readyFlightPromise) return readyFlightPromise;

  const flight = (async () => {
    if (Capacitor.isNativePlatform()) {
      await LiveUpdate.ready();
    }
    resolveReadyBarrier();
  })();

  readyFlightPromise = flight.catch((err) => {
    readyFlightPromise = null;
    console.warn('[LiveUpdate] ready() failed:', err);
    throw err;
  });

  return readyFlightPromise;
};

export const setLiveUpdateReadyPromiseForTest = (p: Promise<void>) => {
  liveUpdateReadyPromise = p;
  readyFlightPromise = p;
};

export const resetLiveUpdateReadyBarrierForTest = () => {
  readyFlightPromise = null;
  liveUpdateReadyPromise = new Promise<void>((resolve) => {
    resolveReadyBarrier = resolve;
  });
  return {
    promise: liveUpdateReadyPromise,
    resolve: resolveReadyBarrier,
  };
};

export const downloadWebBundle = async (manifest: WebUpdateManifest): Promise<void> => {
  await liveUpdateReadyPromise;
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Web 热更新仅在 Android 原生环境生效');
  }
  await LiveUpdate.downloadBundle({
    url: manifest.downloadUrl,
    bundleId: manifest.bundleId,
    checksum: manifest.sha256,
  });
};

export const setNextWebBundle = async (manifest: WebUpdateManifest): Promise<void> => {
  await liveUpdateReadyPromise;
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Web 热更新仅在 Android 原生环境生效');
  }
  await LiveUpdate.setNextBundle({
    bundleId: manifest.bundleId,
  });
};

const throwIfWebUpdateCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('更新下载已取消', 'AbortError');
};

export const downloadAndApplyWebUpdate = async (
  manifest: WebUpdateManifest,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> => {
  await liveUpdateReadyPromise;
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Web 热更新仅在 Android 原生环境生效');
  }
  throwIfWebUpdateCancelled(signal);
  const progressHandle = onProgress
    ? await LiveUpdate.addListener('downloadBundleProgress', event => {
        if (event.bundleId !== manifest.bundleId || signal?.aborted) return;
        onProgress(Math.max(0, Math.min(1, event.progress)));
      })
    : null;
  let isDownloaded = false;
  let isStaged = false;
  try {
    throwIfWebUpdateCancelled(signal);
    await LiveUpdate.downloadBundle({
      url: manifest.downloadUrl, bundleId: manifest.bundleId, checksum: manifest.sha256,
    });
    isDownloaded = true;
    throwIfWebUpdateCancelled(signal);
    onProgress?.(1);
    throwIfWebUpdateCancelled(signal);
    await LiveUpdate.setNextBundle({ bundleId: manifest.bundleId });
    isStaged = true;
  } catch (error) {
    throwIfWebUpdateCancelled(signal);
    throw error;
  } finally {
    try {
      await progressHandle?.remove();
    } finally {
      // LiveUpdate 6 cannot abort network IO. Drain it before releasing the session
      // slot, and remove cancelled content even if cancellation races staging/cleanup.
      if (signal?.aborted && isDownloaded) {
        if (isStaged) await LiveUpdate.setNextBundle({ bundleId: null });
        await LiveUpdate.deleteBundle({ bundleId: manifest.bundleId });
      }
    }
  }
  throwIfWebUpdateCancelled(signal);
};
export const getCurrentBundle = async (): Promise<{ bundleId: string | null }> => {
  if (!Capacitor.isNativePlatform()) return { bundleId: null };
  return LiveUpdate.getCurrentBundle();
};

export const getNextBundle = async (): Promise<{ bundleId: string | null }> => {
  if (!Capacitor.isNativePlatform()) return { bundleId: null };
  return LiveUpdate.getNextBundle();
};

export const reloadWebRuntime = async (): Promise<void> => {
  await liveUpdateReadyPromise;
  if (Capacitor.isNativePlatform()) {
    await LiveUpdate.reload();
  } else {
    window.location.reload();
  }
};

export const resetWebBundle = async (): Promise<void> => {
  await liveUpdateReadyPromise;
  if (Capacitor.isNativePlatform()) {
    await LiveUpdate.reset();
    await LiveUpdate.reload();
  } else {
    window.location.reload();
  }
};

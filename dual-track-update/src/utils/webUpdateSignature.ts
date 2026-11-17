import type { WebUpdateManifest } from './updateStrategy';

export const WEB_UPDATE_SIGNATURE_ALGORITHM = 'ECDSA_P256_SHA256' as const;

export type WebUpdateManifestPayload = Omit<WebUpdateManifest, 'signatureAlgorithm' | 'keyId' | 'signature'>;
export type SignedWebUpdateManifest = WebUpdateManifest & Required<
  Pick<WebUpdateManifest, 'signatureAlgorithm' | 'keyId' | 'signature'>
>;

const textEncoder = new TextEncoder();

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('Web 更新签名或公钥不是合法 Base64');
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** 发布端与客户端共享的固定字段、固定顺序签名载荷。 */
export const canonicalizeWebUpdateManifest = (manifest: WebUpdateManifestPayload): string => JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  bundleId: manifest.bundleId,
  buildNumber: manifest.buildNumber,
  webVersion: manifest.webVersion,
  sourceSha: manifest.sourceSha,
  downloadUrl: manifest.downloadUrl,
  sha256: manifest.sha256,
  sizeBytes: manifest.sizeBytes,
  runtimeId: manifest.runtimeId,
  publishedAt: manifest.publishedAt || '',
  releaseNotes: manifest.releaseNotes || [],
});

export const verifyWebUpdateManifestSignature = async (
  manifest: SignedWebUpdateManifest,
  trustedPublicKeyBase64: string,
  trustedKeyId: string,
): Promise<void> => {
  if (!trustedPublicKeyBase64.trim() || !trustedKeyId.trim()) {
    throw new Error('当前 APK 未配置 Web 更新可信公钥，已拒绝热更新');
  }
  if (manifest.signatureAlgorithm !== WEB_UPDATE_SIGNATURE_ALGORITHM) {
    throw new Error(`不受支持的 Web 更新签名算法: ${manifest.signatureAlgorithm}`);
  }
  if (manifest.keyId !== trustedKeyId) {
    throw new Error(`Web 更新签名 keyId 不受信任: ${manifest.keyId}`);
  }

  const publicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(trustedPublicKeyBase64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64ToBytes(manifest.signature),
    textEncoder.encode(canonicalizeWebUpdateManifest(manifest)),
  );
  if (!isValid) throw new Error('Web 更新清单签名无效，已拒绝热更新');
};

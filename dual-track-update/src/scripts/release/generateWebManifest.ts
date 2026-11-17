import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  canonicalizeWebUpdateManifest,
  WEB_UPDATE_SIGNATURE_ALGORITHM,
} from '../../utils/webUpdateSignature';

export interface GenerateWebManifestOptions {
  bundleFile?: string;
  outputFile?: string;
  publicRepo?: string;
  assetReleaseTag?: string;
  webTag?: string;
  buildNumber?: number;
  appVersionTag?: string;
  sourceSha?: string;
  signingPrivateKeyBase64?: string;
  signingPublicKeyBase64?: string;
  signingKeyId?: string;
  runtimeId?: number;
}

export const generateWebManifest = (options: GenerateWebManifestOptions = {}) => {
  const bundleFile = options.bundleFile || 'web-bundle.zip';
  const outputFile = options.outputFile || 'web-update-manifest.json';
  const publicRepo = options.publicRepo || process.env.PUBLIC_RELEASES_REPO || '';
  const assetReleaseTag = options.assetReleaseTag
    || process.env.WEB_ASSET_RELEASE_TAG
    || options.webTag
    || process.env.WEB_RELEASE_TAG
    || '';
  const buildNumber = options.buildNumber ?? Number(process.env.BUILD_NUMBER || 0);
  const appVersionTag = options.appVersionTag || process.env.VERSION_TAG || '';
  const sourceSha = options.sourceSha || process.env.GITHUB_SHA || '';
  const signingPrivateKeyBase64 = options.signingPrivateKeyBase64
    || process.env.WEB_UPDATE_SIGNING_PRIVATE_KEY_BASE64
    || '';
  const signingPublicKeyBase64 = options.signingPublicKeyBase64
    || process.env.WEB_UPDATE_SIGNING_PUBLIC_KEY_BASE64
    || '';
  const signingKeyId = options.signingKeyId || process.env.WEB_UPDATE_SIGNING_KEY_ID || '';
  const runtimeId = options.runtimeId ?? Number(
    JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'runtime-version.json'), 'utf8')).runtimeId,
  );

  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error(`GITHUB_SHA 必须是完整 40 位源码 SHA，实际为: ${sourceSha || '(empty)'}`);
  }
  if (!signingPrivateKeyBase64.trim() || !signingPublicKeyBase64.trim() || !signingKeyId.trim()) {
    throw new Error('缺少 Web 更新签名私钥、公钥或 keyId');
  }

  const buffer = fs.readFileSync(bundleFile);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const stat = fs.statSync(bundleFile);

  const unsignedManifest = {
    schemaVersion: 2 as const,
    bundleId: `${appVersionTag}.${buildNumber}`,
    buildNumber,
    webVersion: appVersionTag,
    sourceSha,
    downloadUrl: `https://github.com/${publicRepo}/releases/download/${assetReleaseTag}/web-bundle.zip`,
    sha256,
    sizeBytes: stat.size,
    runtimeId,
    publishedAt: new Date().toISOString(),
    releaseNotes: [
      `Web 热更新构建 #${buildNumber} (${sourceSha.slice(0, 7)})`,
      '即开即用，秒级静默更新',
    ],
  };

  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(signingPrivateKeyBase64.replace(/\s+/g, ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Web 更新签名私钥必须为 ECDSA P-256 PKCS8 DER');
  }
  const derivedPublicKeyBase64 = crypto.createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  if (derivedPublicKeyBase64 !== signingPublicKeyBase64.replace(/\s+/g, '')) {
    throw new Error('Web 更新签名公钥与私钥不匹配');
  }
  const signature = crypto.sign(
    'sha256',
    Buffer.from(canonicalizeWebUpdateManifest(unsignedManifest), 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64');
  const manifest = {
    ...unsignedManifest,
    signatureAlgorithm: WEB_UPDATE_SIGNATURE_ALGORITHM,
    keyId: signingKeyId,
    signature,
  };

  fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
};

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  const manifest = generateWebManifest();
  console.log('Generated web-update-manifest.json (Schema 2):\n', JSON.stringify(manifest, null, 2));
}

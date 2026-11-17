import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateWebManifest } from '../scripts/release/generateWebManifest';
import { verifyWebUpdateManifestSignature } from '../utils/webUpdateSignature';

describe('generateWebManifest 资产 Release 标签', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingPrivateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const signingPublicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const tmpDir = path.resolve(__dirname, '../node_modules/.tmp-web-manifest-test');
  const bundleFile = path.join(tmpDir, 'web-bundle.zip');
  const outputFile = path.join(tmpDir, 'web-update-manifest.json');
  const originalWebAssetReleaseTag = process.env.WEB_ASSET_RELEASE_TAG;
  const originalWebReleaseTag = process.env.WEB_RELEASE_TAG;

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(bundleFile, 'mock-web-bundle');
    delete process.env.WEB_ASSET_RELEASE_TAG;
    delete process.env.WEB_RELEASE_TAG;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalWebAssetReleaseTag === undefined) delete process.env.WEB_ASSET_RELEASE_TAG;
    else process.env.WEB_ASSET_RELEASE_TAG = originalWebAssetReleaseTag;
    if (originalWebReleaseTag === undefined) delete process.env.WEB_RELEASE_TAG;
    else process.env.WEB_RELEASE_TAG = originalWebReleaseTag;
  });

  const generate = () => generateWebManifest({
    bundleFile,
    outputFile,
    publicRepo: 'test/releases',
    buildNumber: 123,
    appVersionTag: '1.2.3',
    sourceSha: 'a'.repeat(40),
    signingPrivateKeyBase64,
    signingPublicKeyBase64,
    signingKeyId: 'test-key-1',
  });

  it('普通 Web 资产使用 Web Release 标签', () => {
    process.env.WEB_ASSET_RELEASE_TAG = 'web-v1.2.3-123';
    expect(generate().downloadUrl).toBe(
      'https://github.com/test/releases/releases/download/web-v1.2.3-123/web-bundle.zip',
    );
  });

  it('APK 资产覆盖使用 Android Release 标签', () => {
    process.env.WEB_ASSET_RELEASE_TAG = 'android-v1.2.3-100123';
    process.env.WEB_RELEASE_TAG = 'web-v1.2.3-123';
    expect(generate().downloadUrl).toBe(
      'https://github.com/test/releases/releases/download/android-v1.2.3-100123/web-bundle.zip',
    );
  });

  it('缺少资产标签覆盖时兼容回退到 WEB_RELEASE_TAG', () => {
    process.env.WEB_RELEASE_TAG = 'web-v1.2.3-legacy';
    expect(generate().downloadUrl).toBe(
      'https://github.com/test/releases/releases/download/web-v1.2.3-legacy/web-bundle.zip',
    );
  });

  it('签名覆盖清单身份字段且带有明确 keyId', () => {
    process.env.WEB_RELEASE_TAG = 'web-v1.2.3-123';
    const manifest = generate();
    expect(manifest.signatureAlgorithm).toBe('ECDSA_P256_SHA256');
    expect(manifest.keyId).toBe('test-key-1');
    expect(manifest.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('客户端可信公钥可验证清单，任一身份字段被改写后拒绝', async () => {
    process.env.WEB_RELEASE_TAG = 'web-v1.2.3-123';
    const manifest = generate();
    await expect(verifyWebUpdateManifestSignature(
      manifest,
      signingPublicKeyBase64,
      'test-key-1',
    )).resolves.toBeUndefined();
    await expect(verifyWebUpdateManifestSignature(
      { ...manifest, sourceSha: 'b'.repeat(40) },
      signingPublicKeyBase64,
      'test-key-1',
    )).rejects.toThrow(/签名无效/);
  });

  it('发布端拒绝不匹配的公私钥', () => {
    expect(() => generateWebManifest({
      bundleFile,
      outputFile,
      publicRepo: 'test/releases',
      assetReleaseTag: 'web-v1.2.3-123',
      buildNumber: 123,
      appVersionTag: '1.2.3',
      sourceSha: 'a'.repeat(40),
      signingPrivateKeyBase64,
      signingPublicKeyBase64: Buffer.from('wrong-key').toString('base64'),
      signingKeyId: 'test-key-1',
    })).toThrow(/公钥与私钥不匹配/);
  });
});

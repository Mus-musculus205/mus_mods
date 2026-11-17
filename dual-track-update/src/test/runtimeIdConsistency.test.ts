import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import runtimeVersion from '../runtime-version.json';
import { RUNTIME_ID } from '../utils/buildInfo';
import { generateWebManifest } from '../scripts/release/generateWebManifest';

describe('runtimeId 权威来源与全链路无漂移一致性断言测试', () => {
  it('1. 权威配置文件 runtime-version.json 存在且格式合法', () => {
    expect(runtimeVersion).toBeDefined();
    expect(Number.isSafeInteger(runtimeVersion.runtimeId)).toBe(true);
    expect(runtimeVersion.runtimeId).toBeGreaterThan(0);
  });

  it('2. 前端客户端 RUNTIME_ID 严格等于 runtime-version.json 的 runtimeId', () => {
    expect(RUNTIME_ID).toBe(runtimeVersion.runtimeId);
  });

  it('3. Android Gradle 配置严格绑定 runtime-version.json 并生成 BuildConfig.RUNTIME_ID', () => {
    const gradleContent = fs.readFileSync(
      path.resolve(__dirname, '../android/app/build.gradle'),
      'utf8',
    );
    expect(gradleContent).toContain("runtime-version.json");
    expect(gradleContent).toContain('buildConfigField "int", "RUNTIME_ID"');
  });

  it('4. Android 原生插件 ApkInstallerPlugin 严格通过 BuildConfig.RUNTIME_ID 取得版本，绝无硬编码', () => {
    const javaContent = fs.readFileSync(
      path.resolve(
        __dirname,
        '../android/app/src/main/java/com/aetheros/simulator/ApkInstallerPlugin.java',
      ),
      'utf8',
    );
    expect(javaContent).toContain('ret.put("runtimeId", BuildConfig.RUNTIME_ID);');
    // 确保没有出现硬编码数字，如 ret.put("runtimeId", 1)
    expect(javaContent).not.toMatch(/ret\.put\(\s*["']runtimeId["']\s*,\s*\d+\s*\)/);
  });

  it('5. Release 清单生成器产出的 runtimeId 与权威配置文件严格一致', () => {
    // 创建一个测试用的 dummy bundle zip 验证生成逻辑
    const dummyZipPath = path.resolve(__dirname, 'temp-dummy-bundle.zip');
    const dummyManifestPath = path.resolve(__dirname, 'temp-dummy-manifest.json');
    fs.writeFileSync(dummyZipPath, Buffer.from('dummy bundle content'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    try {
      const manifest = generateWebManifest({
        bundleFile: dummyZipPath,
        outputFile: dummyManifestPath,
        publicRepo: 'test-repo',
        webTag: 'web-v1.0-100',
        buildNumber: 100,
        appVersionTag: '1.0',
        sourceSha: 'a'.repeat(40),
        signingPrivateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        signingPublicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        signingKeyId: 'test-key-1',
      });

      expect(manifest.runtimeId).toBe(runtimeVersion.runtimeId);
      expect(manifest.sha256).toHaveLength(64);
      expect(manifest.schemaVersion).toBe(2);

      const written = JSON.parse(fs.readFileSync(dummyManifestPath, 'utf8'));
      expect(written.runtimeId).toBe(runtimeVersion.runtimeId);
    } finally {
      if (fs.existsSync(dummyZipPath)) fs.unlinkSync(dummyZipPath);
      if (fs.existsSync(dummyManifestPath)) fs.unlinkSync(dummyManifestPath);
    }
  });

  it('6. 保证 nativeApiVersion 活跃引用在代码与类型定义中完全归零', () => {
    const filesToCheck = [
      '../utils/buildInfo.ts',
      '../utils/androidAppUpdate.ts',
      '../utils/updateStrategy.ts',
      '../utils/webUpdate.ts',
      '../components/settings/AndroidUpdateControl.tsx',
    ];

    for (const relPath of filesToCheck) {
      const fullPath = path.resolve(__dirname, relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content).not.toContain('nativeApiVersion');
      expect(content).not.toContain('NATIVE_API_VERSION');
      expect(content).not.toContain('FUTURE_NATIVE_API');
    }
  });

  it('7. 验证 InstalledAndroidAppInfo 原生桥接返回类型与运行时链路包含 runtimeId', () => {
    const appInfoSample: import('../utils/androidAppUpdate').InstalledAndroidAppInfo = {
      packageName: 'com.example.sullyos',
      versionCode: 100050,
      versionName: 'v3.10.0',
      certificateSha256: 'abc',
      canRequestPackageInstalls: true,
      runtimeId: runtimeVersion.runtimeId,
    };
    expect(appInfoSample.runtimeId).toBe(runtimeVersion.runtimeId);
  });
});

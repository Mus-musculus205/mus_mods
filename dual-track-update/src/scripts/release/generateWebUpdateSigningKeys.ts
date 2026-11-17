import crypto from 'crypto';

const keyId = String(process.argv[2] || '').trim();
if (!/^[A-Za-z0-9._-]{3,64}$/.test(keyId)) {
  console.error('用法: pnpm exec tsx scripts/release/generateWebUpdateSigningKeys.ts <key-id>');
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

console.log('请分别配置以下 GitHub Actions Secrets；私钥只显示这一次：');
console.log(`WEB_UPDATE_SIGNING_KEY_ID=${keyId}`);
console.log(`WEB_UPDATE_SIGNING_PUBLIC_KEY_BASE64=${publicKeyBase64}`);
console.log(`WEB_UPDATE_SIGNING_PRIVATE_KEY_BASE64=${privateKeyBase64}`);

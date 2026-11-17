import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export interface ReleaseVersioningInput {
  appVersion: string;
  commitCount: number;
  runNumber: number;
  previousBuildNumber: number;
  previousVersionCode: number;
}

export const computeReleaseVersioning = (input: ReleaseVersioningInput) => {
  const versionTag = input.appVersion.split(' ')[0].replace(/^v/, '');
  const buildNumber = Math.max(input.commitCount, input.runNumber, input.previousBuildNumber + 1);
  const versionCode = Math.max(100000 + input.runNumber, input.previousVersionCode + 1);
  return {
    versionName: input.appVersion,
    versionTag,
    buildNumber,
    versionCode,
    apkReleaseTag: `android-v${versionTag}-${versionCode}`,
    webReleaseTag: `web-v${versionTag}-${buildNumber}`,
  };
};

const readJsonNumber = (file: string, key: string): number => {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8'))[key]) || 0;
  } catch {
    return 0;
  }
};

export const runComputeVersioning = (cwd = process.cwd()) => {
  const buildInfoContent = fs.readFileSync(path.join(cwd, 'utils/buildInfo.ts'), 'utf8');
  const appVersion = buildInfoContent.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.trim();
  if (!appVersion) throw new Error('无法解析 APP_VERSION');
  const commitCount = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' }).trim()) || 0;
  const releasesDir = process.env.RELEASES_DIR || path.join(cwd, 'releases-repo');
  const result = computeReleaseVersioning({
    appVersion,
    commitCount,
    runNumber: Number(process.env.GITHUB_RUN_NUMBER) || 0,
    previousBuildNumber: readJsonNumber(path.join(releasesDir, 'web-update-manifest.json'), 'buildNumber'),
    previousVersionCode: readJsonNumber(path.join(releasesDir, 'update-manifest.json'), 'versionCode'),
  });
  const lines = [
    `VERSION_NAME=${result.versionName}`,
    `VERSION_TAG=${result.versionTag}`,
    `VERSION_CODE=${result.versionCode}`,
    `BUILD_NUMBER=${result.buildNumber}`,
    `APK_RELEASE_TAG=${result.apkReleaseTag}`,
    `WEB_RELEASE_TAG=${result.webReleaseTag}`,
  ].join('\n') + '\n';
  if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV 未配置');
  fs.appendFileSync(process.env.GITHUB_ENV, lines, 'utf8');
  console.log(lines);
  return result;
};

if (process.argv[1] && process.argv[1].endsWith('computeVersioning.ts')) {
  try {
    runComputeVersioning();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

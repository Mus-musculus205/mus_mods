import { describe, expect, it } from 'vitest';
import { computeReleaseVersioning } from '../scripts/release/computeVersioning';

describe('发布版本号单调性', () => {
  it('普通历史使用较大的 commit count', () => {
    expect(computeReleaseVersioning({
      appVersion: '3.10.0 Example',
      commitCount: 3000,
      runNumber: 200,
      previousBuildNumber: 2990,
      previousVersionCode: 100199,
    })).toMatchObject({ buildNumber: 3000, versionCode: 100200 });
  });

  it('历史重写使 commit count 降低时仍严格高于两个远端指针', () => {
    expect(computeReleaseVersioning({
      appVersion: '3.10.0 Example',
      commitCount: 20,
      runNumber: 3,
      previousBuildNumber: 3550,
      previousVersionCode: 100500,
    })).toMatchObject({
      buildNumber: 3551,
      versionCode: 100501,
      webReleaseTag: 'web-v3.10.0-3551',
      apkReleaseTag: 'android-v3.10.0-100501',
    });
  });
});

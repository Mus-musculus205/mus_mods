import { describe, expect, it } from 'vitest';
import { pruneReleases, referencedTags, selectReleasesToPrune, type ReleaseSummary } from '../scripts/release/pruneReleases';

const release = (tagName: string, day: number, extra: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
  tagName, createdAt: new Date(Date.UTC(2026, 9, day)).toISOString(), isDraft: false, isLatest: false, ...extra,
});

describe('pruneReleases', () => {
  it('每类只留最新 N 个；指针引用、Latest、草稿和不认识的前缀都不删', () => {
    const releases = [
      release('android-v1-105', 10, { isLatest: true }),
      release('android-v1-104', 9),
      release('android-v1-103', 8), // Web 指针引用它的 web-bundle.zip
      release('android-v1-102', 7),
      release('web-v1-30', 10),
      release('web-v1-29', 9),
      release('web-v1-28', 8),
      release('web-v1-27', 7, { isDraft: true }),
      release('legacy-1', 1),
    ];
    expect(selectReleasesToPrune(releases, { apk: 2, web: 1 }, ['android-v1-103']))
      .toEqual(['web-v1-29', 'web-v1-28', 'android-v1-102']);
  });

  it('从指针地址里认出 tag，APK 用的 latest 地址不算引用', () => {
    expect(referencedTags(JSON.stringify({
      downloadUrl: 'https://github.com/o/r/releases/download/android-v3.10.0-100139/web-bundle.zip',
      apkUrl: 'https://github.com/o/r/releases/latest/download/SullyOS-latest.apk',
    }))).toEqual(['android-v3.10.0-100139']);
  });

  it('按指针保护后删除多余的 Release 并清掉 tag', () => {
    const commands: string[] = [];
    const releases = [
      release('android-v1-3', 3, { isLatest: true }), release('android-v1-2', 2), release('android-v1-1', 1),
      release('web-v1-9', 9),
    ];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('contents/web-update-manifest.json')) return '{"downloadUrl":"https://x/releases/download/android-v1-1/web-bundle.zip"}';
      if (cmd.includes('contents/update-manifest.json')) return '{"apkUrl":"https://x/releases/latest/download/a.apk"}';
      if (cmd.includes('gh release list')) return JSON.stringify(releases);
      return '';
    };
    const result = pruneReleases({ publicRepo: 'o/r', keep: { apk: 1, web: 5 }, exec });
    expect(result.deleted).toEqual(['android-v1-2']);
    expect(commands).toContain('gh release delete "android-v1-2" --repo "o/r" --yes --cleanup-tag');
  });

  it('读不到 Web 指针引用的 Release 时整次放弃，一个都不删', () => {
    const commands: string[] = [];
    const exec = (cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('contents/')) return '{}';
      return '[]';
    };
    expect(() => pruneReleases({ publicRepo: 'o/r', exec })).toThrow(/放弃清理/);
    expect(commands.some((cmd) => cmd.includes('gh release delete') || cmd.includes('gh release list'))).toBe(false);
  });
});

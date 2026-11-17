import { execSync } from 'child_process';

/**
 * 清理公开 Release 仓库里的旧 Release：APK（android-*）只留最新 N 个，Web（web-*）只留最新 M 个。
 *
 * 不论排第几都不删的：
 * - 稳定指针（update-manifest.json / web-update-manifest.json）的下载地址里引用的 Release。
 *   APK 发布也会带 Web 包，Web 指针经常指向 android-* 那个 Release，删了客户端就下载不到。
 * - 标记为 Latest 的 Release：APK 清单用的是 releases/latest/download/... 地址。
 * - 本次刚发布的 Release，以及草稿（草稿是没发完的，由下次发布的 repair 接着用）。
 * 其他前缀的 Release 不认识，也不碰。
 *
 * 读不到指针就整次放弃清理并报错：不知道谁在被引用时，删哪个都可能删到正在用的。
 */

export interface ReleaseSummary {
  tagName: string;
  createdAt: string;
  isDraft: boolean;
  isLatest: boolean;
}

export interface PruneKeep {
  apk: number;
  web: number;
}

export const DEFAULT_KEEP: PruneKeep = { apk: 2, web: 5 };

const POINTER_FILES = ['update-manifest.json', 'web-update-manifest.json'] as const;

const kindOf = (tagName: string): keyof PruneKeep | null => {
  if (tagName.startsWith('android-')) return 'apk';
  if (tagName.startsWith('web-')) return 'web';
  return null;
};

/** 指针清单里所有 releases/download/<tag>/ 形式的地址引用到的 tag。 */
export const referencedTags = (manifestText: string): string[] => {
  const tags = new Set<string>();
  for (const match of manifestText.matchAll(/\/releases\/download\/([^/"\s]+)\//g)) {
    tags.add(decodeURIComponent(match[1]));
  }
  return [...tags];
};

/** 选出要删的 tag，新的在前排序后每类保留前 N 个，受保护的一律保留。 */
export const selectReleasesToPrune = (
  releases: ReleaseSummary[],
  keep: PruneKeep,
  protectedTags: Iterable<string>,
): string[] => {
  const protectedSet = new Set(protectedTags);
  const kept: Record<keyof PruneKeep, number> = { apk: 0, web: 0 };
  const newestFirst = releases
    .filter((release) => !release.isDraft && kindOf(release.tagName))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.tagName.localeCompare(a.tagName));
  const doomed: string[] = [];
  for (const release of newestFirst) {
    const kind = kindOf(release.tagName)!;
    if (kept[kind] < keep[kind]) {
      kept[kind] += 1;
      continue;
    }
    if (release.isLatest || protectedSet.has(release.tagName)) continue;
    doomed.push(release.tagName);
  }
  return doomed;
};

export interface PruneReleasesOptions {
  publicRepo: string;
  keep?: PruneKeep;
  /** 本次刚发布的 tag，额外保护。 */
  currentTags?: string[];
  dryRun?: boolean;
  exec?: (cmd: string, options?: any) => string | Buffer;
}

export const pruneReleases = (options: PruneReleasesOptions): { deleted: string[]; protectedTags: string[] } => {
  const exec = options.exec || execSync;
  const keep = options.keep || DEFAULT_KEEP;
  const repo = options.publicRepo;
  const run = (cmd: string) => String(exec(cmd, { encoding: 'utf8', stdio: 'pipe' }) || '');

  const protectedTags = new Set((options.currentTags || []).filter(Boolean));
  for (const file of POINTER_FILES) {
    const text = run(`gh api "repos/${repo}/contents/${file}" -H "Accept: application/vnd.github.raw"`);
    const tags = referencedTags(text);
    if (file === 'web-update-manifest.json' && tags.length === 0) {
      throw new Error(`[pruneReleases] ${file} 里找不到 releases/download/<tag>/ 地址，不知道 Web 指针引用哪个 Release，放弃清理`);
    }
    tags.forEach((tag) => protectedTags.add(tag));
  }

  const releases = JSON.parse(
    run(`gh release list --repo "${repo}" --limit 1000 --json tagName,createdAt,isDraft,isLatest`),
  ) as ReleaseSummary[];
  const doomed = selectReleasesToPrune(releases, keep, protectedTags);
  const protectedList = [...protectedTags];
  console.log(`[pruneReleases] 共 ${releases.length} 个 Release；保留 APK ${keep.apk} 个、Web ${keep.web} 个；受保护: ${protectedList.join(', ') || '无'}`);
  if (doomed.length === 0) {
    console.log('[pruneReleases] 没有需要清理的 Release');
    return { deleted: [], protectedTags: protectedList };
  }
  for (const tag of doomed) {
    if (options.dryRun) {
      console.log(`[pruneReleases] (dry-run) 将删除 ${tag}`);
      continue;
    }
    run(`gh release delete "${tag}" --repo "${repo}" --yes --cleanup-tag`);
    console.log(`[pruneReleases] 已删除 ${tag}`);
  }
  return { deleted: options.dryRun ? [] : doomed, protectedTags: protectedList };
};

if (process.argv[1] && process.argv[1].endsWith('pruneReleases.ts')) {
  const publicRepo = process.env.PUBLIC_RELEASES_REPO;
  if (!publicRepo) {
    console.error('[pruneReleases] 缺少 PUBLIC_RELEASES_REPO');
    process.exit(1);
  }
  pruneReleases({
    publicRepo,
    currentTags: [process.env.WEB_RELEASE_TAG || '', process.env.APK_RELEASE_TAG || ''],
    dryRun: process.argv.includes('--dry-run'),
  });
}

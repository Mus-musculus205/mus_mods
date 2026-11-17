# Dual-Track Update for SullyOS

给 SullyOS 安卓版用的双轨更新：前端改动走 Web 热更新，原生改动走完整 APK。CI 自己判断这次该发哪一种，手机端启动时检查一次，用户点了才下载和安装。

整套只用 GitHub Actions、GitHub Releases 和一个公开的发布仓库，不需要任何商业 OTA 服务。

## 两条轨道

```text
推送到发布分支
      |
      v
decideRelease：比较本次提交与上次发布的提交
      |
      +-- 只改了前端 --------> web：打包 dist，签名清单，发 Web 热更新
      +-- 改了原生或依赖 ----> apk：构建完整 APK，同时附带同一份 Web 包
      +-- 没有新内容 --------> noop：直接结束
      +-- 提交历史分叉 ------> fail：拒绝发布
```

手机端：

```text
启动 -> LiveUpdate.ready() 解除 10 秒看门狗 -> 检查一次更新
                                              |
            先看 APK：有新底座就提示装 APK -----+
            再看 Web：runtimeId 一致才允许热更新
```

- Web 热更新由 `@capawesome/capacitor-live-update` 负责下载、校验、解压和切换。新包 10 秒内没有调用 `ready()`，插件会自动回滚到 APK 内置的版本。
- APK 更新由本包的 `ApkInstaller` 原生插件下载，校验 SHA-256、包名、签名证书和版本号，全部通过后才交给系统安装器。
- 两边靠一个整数 `runtimeId` 对齐。只有 `remote.runtimeId === installed.runtimeId` 时才允许 Web 热更新，否则提示先升级 APK。

## 包内容

`src/` 下的路径和 SullyOS 仓库根目录一一对应，可以直接复制过去。

```text
dual-track-update/
├─ README.md
├─ LICENSE
└─ src/
   ├─ runtime-version.json                  # runtimeId 唯一来源
   ├─ .github/workflows/
   │  ├─ build-apk.yml                      # 单条发布流水线
   │  └─ rebaseline-apk.yml                 # 手动指定 SHA 重建双基线
   ├─ scripts/release/
   │  ├─ releasePolicy.ts                   # 哪些路径算原生改动；发布决策纯函数
   │  ├─ decideRelease.ts                   # 读公开清单里的 sourceSha，决定 apk / web / noop / fail
   │  ├─ computeVersioning.ts               # BUILD_NUMBER 与 versionCode 严格递增
   │  ├─ generateWebManifest.ts             # 生成并签名 Web 清单（Schema 2）
   │  ├─ generateWebUpdateSigningKeys.ts    # 生成 ECDSA P-256 密钥对
   │  ├─ publishRelease.ts                  # 先传产物，最后推清单指针
   │  ├─ prepareRebaseline.ts               # 重基线的输入校验
   │  └─ pruneReleases.ts                   # 清理旧 Release
   ├─ utils/
   │  ├─ updateStrategy.ts                  # 客户端更新决策
   │  ├─ webUpdate.ts                       # Web 清单解析、签名校验、LiveUpdate 调用
   │  ├─ webUpdateSignature.ts              # 清单规范化与验签
   │  ├─ androidAppUpdate.ts                # APK 清单、下载、校验、安装
   │  ├─ appUpdateCheck.ts                  # 启动时只检查一次
   │  └─ appUpdateSession.ts                # 下载 / 取消 / 安装的应用级会话
   ├─ components/settings/AndroidUpdateControl.tsx   # 设置页里的更新面板
   ├─ android/app/src/main/java/com/aetheros/simulator/
   │  ├─ ApkInstallerPlugin.java
   │  ├─ ApkDownload.java
   │  ├─ UpdateDownloadService.java         # 下载期间的前台服务
   │  └─ NativeFilePolicy.java              # 缓存路径限制与哈希校验
   ├─ scripts/stress-test-live-update.mjs
   ├─ scripts/integration/android/          # 真机 / 模拟器端到端脚本
   └─ test/、utils/*.test.ts                 # 对应单元测试
```

## 安装到 SullyOS

以下路径都相对 SullyOS 仓库根目录。

### 1. 复制源码并装依赖

把 `src/` 里的内容复制到仓库根目录，然后：

```bash
pnpm add @capawesome/capacitor-live-update@^6.7.0
```

需要已经有 `@capacitor/core` 与 `@capacitor/android` 6.x。

如果你的仓库里已经有同名文件（比如 `NativeFilePolicy.java` 或 `ApkInstallerPlugin.java`），请手动合并，不要直接覆盖。

### 2. 全局替换占位符

| 占位符 | 换成 |
| :--- | :--- |
| `your-name/your-app-releases` | 你的公开发布仓库，例如 `someone/my-app-releases` |
| `com.example.sullyos` | 你的 `applicationId` |

发布仓库名也可以不改源码，直接在 GitHub 仓库变量 `PUBLIC_RELEASES_REPO` 里填。

### 3. `capacitor.config.json`

在 `plugins` 里加：

```json
"LiveUpdate": {
  "readyTimeout": 10000,
  "autoDeleteBundles": true
}
```

### 4. Android 工程

`android/app/build.gradle` 顶部读取 `runtime-version.json`，并在 `defaultConfig` 里接收 CI 传入的版本号：

```groovy
def runtimeVersionFile = file('../../runtime-version.json')
def runtimeIdValue = 1
if (runtimeVersionFile.exists()) {
    def parsedJson = new groovy.json.JsonSlurper().parseText(runtimeVersionFile.text)
    runtimeIdValue = parsedJson.runtimeId as Integer
}

android {
    buildFeatures {
        buildConfig = true
    }
    defaultConfig {
        versionCode project.hasProperty('versionCode') ? project.property('versionCode').toInteger() : 1
        versionName project.hasProperty('versionName') ? project.property('versionName') : "1.0"
        buildConfigField "int", "RUNTIME_ID", "${runtimeIdValue}"
    }
    signingConfigs {
        release {
            def keystoreFile = file("release.keystore")
            if (keystoreFile.exists()) {
                storeFile keystoreFile
                storePassword System.getenv("RELEASE_STORE_PASSWORD") ?: ""
                keyAlias System.getenv("RELEASE_KEY_ALIAS") ?: ""
                keyPassword System.getenv("RELEASE_KEY_PASSWORD") ?: ""
            }
        }
    }
    buildTypes {
        release {
            if (file("release.keystore").exists()) {
                signingConfig signingConfigs.release
            }
        }
    }
}
```

`AndroidManifest.xml` 的 `<application>` 里：

```xml
<service
    android:name=".UpdateDownloadService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />

<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data
        android:name="android.support.FILE_PROVIDER_PATHS"
        android:resource="@xml/file_paths" />
</provider>
```

`<manifest>` 里：

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
```

`res/xml/file_paths.xml` 至少要有安装包暂存目录：

```xml
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="verified_installers" path="updates/install/" />
</paths>
```

`MainActivity.java` 的 `onCreate` 里，在 `super.onCreate` 之前注册：

```java
registerPlugin(ApkInstallerPlugin.class);
```

原生代码放在 `com.aetheros.simulator` 包下，跟 SullyOS 原本的 namespace 一致。如果你改过 namespace，请同步修改这四个 Java 文件的 `package` 行。

### 5. 构建号与 runtimeId

`utils/buildInfo.ts` 需要导出下面两个常量，`scripts/release/computeVersioning.ts` 还会从这个文件里读 `APP_VERSION`：

```ts
import runtimeVersion from '../runtime-version.json';

export const BUILD_NUMBER = typeof __BUILD_NUMBER__ !== 'undefined' ? (Number(__BUILD_NUMBER__) || 0) : 0;
export const RUNTIME_ID = runtimeVersion.runtimeId;
```

`vite.config.ts` 的 `define` 里注入构建号，优先用 CI 传入的 `BUILD_NUMBER`：

```ts
const buildNumber = Number(process.env.BUILD_NUMBER) || Number(process.env.GITHUB_RUN_NUMBER) || 0;

define: {
  __BUILD_NUMBER__: JSON.stringify(buildNumber),
},
```

`vite-env.d.ts` 里声明：

```ts
declare const __BUILD_NUMBER__: number;
```

### 6. 启动握手与设置页

`index.tsx` 在根组件 `render` 之后：

```ts
import { initLiveUpdateReady } from './utils/webUpdate';
import { isAppUpdateCheckEnabled, startAppUpdateCheckOnce } from './utils/appUpdateCheck';

void initLiveUpdateReady()
  .then(() => isAppUpdateCheckEnabled() ? startAppUpdateCheckOnce() : undefined)
  .catch(error => console.warn('[AppUpdateCheck] 启动检查失败:', error));
```

`initLiveUpdateReady()` 必须在应用真的能用之后再调用。如果你的应用启动时还要做数据库迁移，就放到迁移完成之后，这样迁移崩溃时看门狗会把坏包回滚掉。

设置页里放上面板即可，非 Android 原生环境下它不会显示：

```tsx
import AndroidUpdateControl from '../components/settings/AndroidUpdateControl';

<AndroidUpdateControl />
```

## 发布端配置

### 1. 建一个公开的发布仓库

例如 `someone/my-app-releases`，默认分支为 `main`，可以是空仓库。它会存放：

- `update-manifest.json`：最新 APK 清单，`sourceSha` 记录上一次构建 APK 的源码提交；
- `web-update-manifest.json`：最新 Web 清单，`sourceSha` 记录当前已发布的源码提交；
- 每次发布对应的 GitHub Release，附带 `SullyOS-latest.apk`、`web-bundle.zip` 等产物。

源码仓库可以是私有的。两边的提交树互相独立，所以 `gh release create` 不传 `--target`，源码提交只写在 Release 说明和清单里。

### 2. 生成 Web 清单签名密钥

```bash
pnpm exec tsx scripts/release/generateWebUpdateSigningKeys.ts web-2026-01
```

私钥只放进 GitHub Actions Secrets，不要提交、不要放进发布仓库或日志。

### 3. 源码仓库的 Secrets 和变量

Secrets：

```text
RELEASES_REPO_TOKEN                  # 能推送发布仓库、创建 Release 的 token
WEB_UPDATE_SIGNING_KEY_ID
WEB_UPDATE_SIGNING_PUBLIC_KEY_BASE64
WEB_UPDATE_SIGNING_PRIVATE_KEY_BASE64
ANDROID_RELEASE_KEYSTORE_BASE64
ANDROID_RELEASE_STORE_PASSWORD
ANDROID_RELEASE_KEY_ALIAS
ANDROID_RELEASE_KEY_PASSWORD
```

变量（可选）：

```text
PUBLIC_RELEASES_REPO                 # 发布仓库 owner/name
```

公钥在构建时嵌进前端，客户端在下载前先验清单签名，再由插件校验包的 SHA-256。

### 4. 触发

- 推送到 `main` 自动运行。发布分支不叫 `main` 的话，改 `build-apk.yml` 里的 `branches`。
- Actions 页手动运行时可以勾选 `force_apk_build`，强制发一次完整 APK。
- 第一次发布时发布仓库里还没有清单，会直接走 APK 轨道。

`build-apk.yml` 里的构建命令是 `pnpm run build`，产物目录是 `dist/`。你的项目不同的话改这一步。

### 5. 哪些改动会走 APK

`scripts/release/releasePolicy.ts` 的 `NATIVE_AFFECTING_PATHS`：

- `android/` 下任何文件；
- `capacitor.config.json` / `capacitor.config.ts`；
- `package.json`、`pnpm-lock.yaml`；
- 两个发布工作流和会进入 APK 的发布脚本；
- `utils/buildInfo.ts`、`runtime-version.json`。

如果你有打包进 APK `assets` 的前端源码（比如原生后台任务执行的 JS 包），Web 热更新换不掉它们。可以在 `decideRelease.ts` 里把这些源文件列表通过 `nativeBundleInputs` 传给 `computeReleaseAction`，命中时会改走 APK。

### 6. 什么时候递增 runtimeId

改动 Web 和原生之间的接口，或者改了持久化数据、导致回滚后的旧内置包读不了，都要把 `runtime-version.json` 里的 `runtimeId` 加一。这个文件本身就在原生路径列表里，改了会自动走 APK。

Web 热更新可以安全做的持久化改动：

- 给已有数据增加可选字段；
- 新增独立的存储表；
- 增加非唯一索引；
- 读取时兼容新旧两种结构。

必须递增 `runtimeId` 走 APK 的：

- 删除或重命名已持久化的必填字段，或改变字段类型；
- 破坏性的语义改动；
- 删除存储表，或清空回滚版本还要用的数据。

CI 不会自动判断业务数据的兼容性，这一类只能靠代码审查。

### 7. 重基线

`rebaseline-apk.yml` 是手动维护入口，用于历史被改写后重新指定一个源码提交作为 APK 和 Web 的双基线。它要求输入目标 SHA 两次、当前两份清单里的 `sourceSha`，以及确认词 `REBASELINE`，任一项不符就拒绝执行。构建内容来自目标 SHA，签名、版本计算和指针推进用的是触发工作流的那一版代码。

## 发布顺序

1. 先建 Release 并上传全部产物（Artifact-First）；
2. 确认产物都在之后，才推送发布仓库里的清单（Pointer-Last）。

客户端拿到新清单时，下载地址一定已经可用。推清单这一步失败的话，直接在 Actions 里 Re-run：已存在且完整的 Release 会被复用，只补推清单。已存在的 Release 如果记录的源码提交和这次不同，会直接失败，不会复用。

## 验证

复制到 SullyOS 后，在仓库根目录：

```bash
pnpm test:run utils/updateStrategy.test.ts utils/webUpdate.test.ts utils/webUpdateStress.test.ts utils/androidAppUpdate.test.ts utils/appUpdateCheck.test.ts utils/appUpdateSession.test.ts utils/appUpdateSession.integration.test.ts test/releaseDecision.test.ts test/releasePublish.test.ts test/releasePrune.test.ts test/releaseRebaseline.test.ts test/releaseVersioning.test.ts test/releaseWebManifest.test.ts test/runtimeIdConsistency.test.ts
pnpm exec tsx scripts/stress-test-live-update.mjs
```

部分测试依赖测试环境里有 `localStorage`。Vitest 用 `node` 环境时，需要在 setup 文件里提供一个内存版 `localStorage`。

真机或模拟器（需要 adb 已连接）：

```bash
node scripts/integration/android/live-update-e2e.mjs
node scripts/integration/android/cold-start-stress.mjs
```

可以用 `ANDROID_SERIAL` 指定设备。包名在 `scripts/integration/android/adb-common.mjs` 的 `DEFAULT_APP_ID` 里改。

发布包生成时的验证结果：

```text
Unit tests: 14 files, 152 passed
Stress script: passed
TypeScript: passed
Android build / device E2E: not run for this package
```

## 排查

查看热更新日志：

```bash
adb logcat -v time LiveUpdate:D Capacitor:D Capacitor/Console:D *:S
```

- `App is ready.`：握手成功，看门狗已解除。
- `App is not ready. Rolling back to default bundle.`：新包 10 秒内没有握手，已回滚。
- `Checksum mismatch.`：包被篡改或下载不完整，没有解压。
- `App was updated. Resetting to default bundle.`：装了新 APK，回到新的内置包。

常见问题：

- 热更新后白屏、资源 404：zip 里多了一层 `dist/`。打包必须在 `dist` 目录里执行 `zip -r ../web-bundle.zip .`。
- 启动约 10 秒后自动刷新：`initLiveUpdateReady()` 没有执行或太晚，看门狗回滚了。
- 提示有更新但始终不生效：可能包已下载等待重启，或 `runtimeId` 不一致被拦下。
- 装了新 APK 仍是旧界面：`versionCode` 没有递增。

## 当前边界

- 只支持 Android。网页版和 iOS 上更新面板不显示。
- 下载被强制停止后不会断点续传。
- LiveUpdate 6.x 不能中途中止下载，取消会等当前传输结束后再删除这次的包。
- 下载完成后不会自动重启，需要用户点击“立即生效”或“继续安装”。
- 客户端只访问清单里写的官方地址，不改写 URL，也不回退到第三方镜像。

## License

本包作为 SullyOS 的修改与衍生代码，沿用上游的 PolyForm Noncommercial License 1.0.0。完整条款见 [`LICENSE`](./LICENSE)。

署名顺序：

```text
Copyright (c) 2024-2026 NMJ (SullyOS / 手抓糯米机)
Dual-Track Update modifications Copyright (c) 2026 mus
```

本包仅授权许可证所定义的非商业用途。分发本包或其修改版本时，必须同时保留完整 LICENSE 与其中所有 `Required Notice:` 行。

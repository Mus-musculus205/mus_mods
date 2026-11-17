package com.aetheros.simulator;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.security.MessageDigest;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private final ApkDownload apkDownload = new ApkDownload();

    @PluginMethod
    public void startUpdateDownloadService(PluginCall call) {
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), UpdateDownloadService.class));
            call.resolve();
        } catch (Exception error) {
            call.reject("无法启动后台下载服务: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void stopUpdateDownloadService(PluginCall call) {
        getContext().stopService(new Intent(getContext(), UpdateDownloadService.class));
        call.resolve();
    }

    @PluginMethod
    public void downloadApk(PluginCall call) {
        String taskId = call.getString("taskId");
        String url = call.getString("url");
        if (taskId == null || taskId.isEmpty() || url == null || !url.startsWith("https://")) {
            call.reject("下载任务与 HTTPS 地址不能为空");
            return;
        }
        try {
            apkDownload.reserve(taskId);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
            return;
        }
        File destination = new File(getContext().getCacheDir(), "updates/SullyOS-update.apk");
        new Thread(() -> {
            try {
                apkDownload.transfer(url, destination, (bytes, total) -> {
                    JSObject event = new JSObject();
                    event.put("taskId", taskId);
                    event.put("bytes", bytes);
                    event.put("contentLength", total);
                    notifyListeners("apkDownloadProgress", event);
                });
                JSObject result = new JSObject();
                result.put("path", Uri.fromFile(destination).toString());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        }, "apk-update-download").start();
    }

    @PluginMethod
    public void cancelApkDownload(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null) {
            call.reject("taskId 不能为空");
            return;
        }
        apkDownload.cancel(taskId);
        call.resolve();
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private String getCertificateSha256(PackageInfo packageInfo) {
        try {
            Signature[] signatures = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                if (packageInfo.signingInfo != null) {
                    if (packageInfo.signingInfo.hasMultipleSigners()) {
                        signatures = packageInfo.signingInfo.getApkContentsSigners();
                    } else {
                        signatures = packageInfo.signingInfo.getSigningCertificateHistory();
                    }
                }
            } else {
                signatures = packageInfo.signatures;
            }

            if (signatures != null && signatures.length > 0) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] certBytes = signatures[0].toByteArray();
                return bytesToHex(md.digest(certBytes));
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private boolean isSignerLineageCompatible(Context context, File apkFile) {
        PackageManager pm = context.getPackageManager();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo installedInfo = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                PackageInfo candidateInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);

                if (installedInfo == null || installedInfo.signingInfo == null ||
                    candidateInfo == null || candidateInfo.signingInfo == null) {
                    return false;
                }

                // 明确拒绝多 Signer（V3 签名不使用多 Signer，多 Signer 属于死路径与增加攻击面）
                if (installedInfo.signingInfo.hasMultipleSigners() || candidateInfo.signingInfo.hasMultipleSigners()) {
                    return false;
                }

                Signature[] installedSigners = installedInfo.signingInfo.getApkContentsSigners();
                if (installedSigners == null || installedSigners.length == 0) return false;
                Signature currentInstalledSigner = installedSigners[0];

                // 核心方向：检查候选待安装 APK 的 lineage 历史中，是否包含当前已安装包的 signer
                Signature[] candidateHistory = candidateInfo.signingInfo.getSigningCertificateHistory();
                if (candidateHistory == null || candidateHistory.length == 0) return false;

                for (Signature sig : candidateHistory) {
                    if (sig.equals(currentInstalledSigner)) {
                        return true;
                    }
                }
                return false;
            } else {
                // API < 28 回退比较单个签名
                PackageInfo installedInfo = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
                PackageInfo candidateInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_SIGNATURES);

                if (installedInfo == null || installedInfo.signatures == null ||
                    candidateInfo == null || candidateInfo.signatures == null) {
                    return false;
                }

                if (installedInfo.signatures.length != 1 || candidateInfo.signatures.length != 1) {
                    return false;
                }

                return installedInfo.signatures[0].equals(candidateInfo.signatures[0]);
            }
        } catch (Exception e) {
            return false;
        }
    }

    private boolean canRequestPackageInstalls() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return getContext().getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    @PluginMethod
    public void getInstalledInfo(PluginCall call) {
        try {
            Context context = getContext();
            String packageName = context.getPackageName();
            PackageManager pm = context.getPackageManager();

            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? PackageManager.GET_SIGNING_CERTIFICATES
                    : PackageManager.GET_SIGNATURES;

            PackageInfo packageInfo = pm.getPackageInfo(packageName, flags);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? packageInfo.getLongVersionCode()
                    : packageInfo.versionCode;
            String versionName = packageInfo.versionName != null ? packageInfo.versionName : "";
            String certSha256 = getCertificateSha256(packageInfo);

            JSObject ret = new JSObject();
            ret.put("packageName", packageName);
            ret.put("versionCode", versionCode);
            ret.put("versionName", versionName);
            ret.put("certificateSha256", certSha256);
            ret.put("canRequestPackageInstalls", canRequestPackageInstalls());
            ret.put("runtimeId", BuildConfig.RUNTIME_ID);


            call.resolve(ret);
        } catch (Exception e) {
            call.reject("获取已安装应用信息失败: " + e.getMessage(), e);
        }
    }

    /**
     * 从 JS 参数里读整数。不用 PluginCall.getLong：Capacitor 6 的实现只认 Long，
     * 而 JSON 里 int 范围内的数（versionCode、几十 MB 的 sizeBytes）会解析成 Integer，
     * 结果总是返回默认值 0，校验永远报「APK version is required」。
     * 缺失或不是整数时返回 0，由调用方按「清单不完整」处理。
     */
    static long wholeNumber(PluginCall call, String name) {
        Object value = call.getData().opt(name);
        if (!(value instanceof Number)) return 0L;
        double number = ((Number) value).doubleValue();
        return number == Math.rint(number) ? ((Number) value).longValue() : 0L;
    }

    private JSObject inspectApk(File apkFile, String hash, long size, long version) throws Exception {
        if (version <= 0) throw new java.io.IOException("APK version is required");
        NativeFilePolicy.verifyDigest(apkFile, hash, size);
        Context context = getContext();
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archiveInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (archiveInfo == null) throw new java.io.IOException("无法解析 APK 文件结构");
        if (!context.getPackageName().equals(archiveInfo.packageName)) throw new java.io.IOException("APK 包名与本应用不一致");
        long candidateVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? archiveInfo.getLongVersionCode() : archiveInfo.versionCode;
        if (candidateVersion != version) throw new java.io.IOException("APK 版本与更新清单不一致");
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), 0);
        long installedVersion = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? installed.getLongVersionCode() : installed.versionCode;
        if (candidateVersion <= installedVersion) throw new java.io.IOException("目标 APK 版本未高于已安装版本");
        if (!isSignerLineageCompatible(context, apkFile)) throw new java.io.IOException("APK 签名与已安装版本不相容");
        JSObject result = new JSObject();
        result.put("valid", true);
        result.put("packageName", archiveInfo.packageName);
        result.put("versionCode", candidateVersion);
        result.put("versionName", archiveInfo.versionName == null ? "" : archiveInfo.versionName);
        result.put("certificateSha256", getCertificateSha256(archiveInfo));
        result.put("canRequestPackageInstalls", canRequestPackageInstalls());
        return result;
    }

    @PluginMethod
    public void verifyApk(PluginCall call) {
        try {
            File apkFile = NativeFilePolicy.updateSource(getContext().getCacheDir(), call.getString("path"));
            call.resolve(inspectApk(apkFile, call.getString("sha256"), wholeNumber(call, "sizeBytes"), wholeNumber(call, "versionCode")));
        } catch (Exception error) {
            // Verification does not own deletion, even for a malformed caller-supplied path.
            call.reject("校验 APK 失败: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        File installCopy = null;
        boolean handedToInstaller = false;
        try {
            Context context = getContext();
            File source = NativeFilePolicy.updateSource(context.getCacheDir(), call.getString("path"));
            String hash = call.getString("sha256");
            long size = wholeNumber(call, "sizeBytes"), version = wholeNumber(call, "versionCode");
            if (hash == null || !hash.matches("[a-fA-F0-9]{64}") || size <= 0 || version <= 0)
                throw new java.io.IOException("安装 APK 必须提供完整更新清单");
            if (!canRequestPackageInstalls()) {
                call.resolve(new JSObject().put("status", "permission_required"));
                return;
            }
            installCopy = NativeFilePolicy.stageApkForInstall(context.getCacheDir(), source, size);
            // Recheck the independent bytes being handed off, including permission-resume calls.
            inspectApk(installCopy, hash, size, version);
            if (!installCopy.setReadOnly()) throw new java.io.IOException("无法保护安装副本");
            Uri contentUri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", installCopy);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            handedToInstaller = true;
            call.resolve(new JSObject().put("status", "installer_opened"));
        } catch (Exception error) {
            call.reject("调起安装器失败: " + error.getMessage(), error);
        } finally {
            // A handoff must keep its file until the receiving installer has consumed it.
            if (!handedToInstaller && installCopy != null && !installCopy.delete())
                android.util.Log.w("ApkInstaller", "Failed to remove rejected install copy");
        }
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Context context = getContext();
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("打开安装未知应用权限设置失败: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void openAppDetailsSettings(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("打开应用详情设置失败: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        try {
            Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
                JSObject ret = new JSObject();
                ret.put("ignoring", ignoring);
                call.resolve(ret);
            } else {
                JSObject ret = new JSObject();
                ret.put("ignoring", true);
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("检查电池优化状态失败: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
                    JSObject ret = new JSObject();
                    ret.put("status", "already_ignoring");
                    call.resolve(ret);
                    return;
                }

                Intent intent = new Intent();
                intent.setAction(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);

                JSObject ret = new JSObject();
                ret.put("status", "requested");
                call.resolve(ret);
            } else {
                JSObject ret = new JSObject();
                ret.put("status", "not_supported");
                call.resolve(ret);
            }
        } catch (Exception e) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Context context = getContext();
                    Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                    JSObject ret = new JSObject();
                    ret.put("status", "opened_settings");
                    call.resolve(ret);
                    return;
                }
            } catch (Exception ignored) {
            }
            call.reject("请求忽略电池优化失败: " + e.getMessage(), e);
        }
    }
}

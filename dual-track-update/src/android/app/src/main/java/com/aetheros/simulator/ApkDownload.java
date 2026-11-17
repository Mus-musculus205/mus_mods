package com.aetheros.simulator;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CancellationException;

/** One cancellable transfer. The slot stays occupied until IO has actually stopped. */
final class ApkDownload {
    interface Progress { void update(long bytes, long total); }
    private String activeTaskId;
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;

    synchronized void reserve(String taskId) {
        if (activeTaskId != null) throw new IllegalStateException("已有 APK 下载任务正在运行");
        activeTaskId = taskId;
        cancelled = false;
    }

    synchronized void cancel(String taskId) {
        if (!taskId.equals(activeTaskId)) return;
        cancelled = true;
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
    }

    private void checkCancelled() {
        if (cancelled) throw new CancellationException("APK 下载已取消");
    }

    void transfer(String url, File destination, Progress progress) throws IOException {
        boolean completed = false;
        try {
            checkCancelled();
            File parent = destination.getParentFile();
            if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("无法创建更新下载目录");
            if (destination.exists() && !destination.delete()) throw new IOException("无法清理旧安装包");
            URL currentUrl = new URL(url);
            for (int redirects = 0; ; redirects++) {
                checkCancelled();
                if (!"https".equalsIgnoreCase(currentUrl.getProtocol())) throw new IOException("APK 地址必须使用 HTTPS");
                HttpURLConnection current = (HttpURLConnection) currentUrl.openConnection();
                connection = current;
                checkCancelled();
                current.setInstanceFollowRedirects(false);
                current.setConnectTimeout(15_000);
                current.setReadTimeout(180_000);
                current.setRequestProperty("Accept-Encoding", "identity");
                int status = current.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = current.getHeaderField("Location");
                    current.disconnect();
                    if (location == null || redirects >= 5) throw new IOException("APK 下载重定向无效");
                    currentUrl = new URL(currentUrl, location);
                    continue;
                }
                if (status != 200) throw new IOException("APK 下载失败（HTTP " + status + "）");
                String lengthHeader = current.getHeaderField("Content-Length");
                long total = lengthHeader == null ? -1 : Long.parseLong(lengthHeader);
                long bytes = 0;
                long lastProgress = 0;
                try (InputStream input = current.getInputStream(); FileOutputStream output = new FileOutputStream(destination)) {
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        checkCancelled();
                        output.write(buffer, 0, count);
                        bytes += count;
                        long now = System.nanoTime();
                        if (now - lastProgress > 250_000_000L) {
                            progress.update(bytes, total);
                            lastProgress = now;
                        }
                    }
                }
                checkCancelled();
                if (total > 0 && bytes != total) throw new IOException("APK 下载未完成");
                progress.update(bytes, total);
                completed = true;
                break;
            }
        } catch (IOException error) {
            checkCancelled();
            throw error;
        } finally {
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
            connection = null;
            if (!completed && destination.exists() && !destination.delete()) {
                System.err.println("[ApkDownload] 无法清理未完成文件: " + destination);
            }
            synchronized (this) { activeTaskId = null; }
        }
    }
}

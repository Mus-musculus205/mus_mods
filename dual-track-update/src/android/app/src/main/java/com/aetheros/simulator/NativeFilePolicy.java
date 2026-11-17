package com.aetheros.simulator;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URI;
import java.security.MessageDigest;

/** Files admitted by the export/update bridges. Checks are enforced independently of JS callers. */
final class NativeFilePolicy {
    private NativeFilePolicy() {}

    private static File localFile(File cache, String path) throws Exception {
        if (path == null || path.isEmpty()) throw new IOException("A local staged file is required");
        if (path.startsWith("file:")) return new File(new URI(path)).getCanonicalFile();
        if (path.contains("://")) throw new IOException("Only staged local files are accepted");
        File file = new File(path);
        return (file.isAbsolute() ? file : new File(cache, path)).getCanonicalFile();
    }

    private static File inside(File root, File candidate) throws IOException {
        File actual = candidate.getCanonicalFile();
        if (!actual.getPath().startsWith(root.getPath() + File.separator))
            throw new IOException("File is outside the permitted staging directory");
        return actual;
    }

    static File exportSource(File cache, String path) throws Exception {
        File root = new File(cache.getCanonicalFile(), "sullyos-export");
        File file = inside(root, localFile(cache, path));
        if (!file.isFile()) throw new IOException("Staged export file not found");
        return file;
    }

    static void checkFileName(String name) throws IOException {
        if (name == null || name.trim().isEmpty() || name.length() > 240 || name.equals(".") || name.equals("..")
            || name.matches("(?s).*[<>:\"/\\\\|?*\\p{Cntrl}].*")) throw new IOException("Invalid output file name");
    }

    static File downloadTarget(File downloads, String name) throws IOException {
        checkFileName(name);
        File root = new File(downloads.getCanonicalFile(), "SullyOS");
        return inside(root, new File(root, name));
    }

    static File updateSource(File cache, String path) throws Exception {
        File expected = new File(cache.getCanonicalFile(), "updates/SullyOS-update.apk");
        File file = localFile(cache, path);
        if (!file.equals(expected) || !file.isFile()) throw new IOException("Only the downloaded update APK is accepted");
        return file;
    }

    static void verifyDigest(File file, String hash, long size) throws Exception {
        if (hash == null || !hash.matches("[a-fA-F0-9]{64}") || size <= 0) throw new IOException("APK hash and size are required");
        if (file.length() != size) throw new IOException("APK size does not match the manifest");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
        }
        StringBuilder actual = new StringBuilder();
        for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
        if (!actual.toString().equalsIgnoreCase(hash)) throw new IOException("APK SHA-256 does not match the manifest");
    }

    /** An installer never reads the shared download destination that a later retry may overwrite. */
    static File stageApkForInstall(File cache, File source, long expectedSize) throws Exception {
        if (expectedSize <= 0 || source.length() != expectedSize) throw new IOException("APK size does not match the manifest");
        File directory = new File(cache.getCanonicalFile(), "updates/install/");
        if (!directory.getCanonicalFile().equals(directory)) throw new IOException("Invalid install staging directory");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create install staging directory");
        File copy = File.createTempFile("verified-", ".apk", directory);
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(copy)) {
            byte[] buffer = new byte[65536];
            long total = 0;
            for (int count; (count = input.read(buffer)) != -1;) {
                total += count;
                if (total > expectedSize) throw new IOException("APK changed during staging");
                output.write(buffer, 0, count);
            }
            if (total != expectedSize) throw new IOException("APK changed during staging");
            return copy;
        } catch (Exception error) {
            if (!copy.delete()) error.addSuppressed(new IOException("Cannot remove failed install staging file"));
            throw error;
        }
    }
}

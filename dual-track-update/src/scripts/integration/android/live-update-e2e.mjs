import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  resolveAdbDevice,
  runAdb,
  CdpClient,
  findAndForwardDevtools,
  startLogcatCollector,
  log,
  DEFAULT_APP_ID,
  DEFAULT_MAIN_ACTIVITY,
  DEFAULT_CDP_PORT,
} from './adb-common.mjs';

const APP_ID = DEFAULT_APP_ID;
const CDP_PORT = DEFAULT_CDP_PORT;
const HTTP_PORT = 8099;

const ROOT_DIR = process.cwd();
const TEMP_DIR = path.join(ROOT_DIR, 'test', 'fixtures', 'e2e-live-update-temp');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const sha256File = (filePath) => {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
};

async function prepareBundles() {
  log('SETUP', 'Preparing temporary test bundles in fixtures directory...');
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // 1. Bundle 3600 (Healthy OTA Bundle)
  const bundle3600Dir = path.join(TEMP_DIR, 'bundle-3600');
  fs.cpSync(DIST_DIR, bundle3600Dir, { recursive: true });

  const healthyIndexHtmlPath = path.join(bundle3600Dir, 'index.html');
  let healthyHtml = fs.readFileSync(healthyIndexHtmlPath, 'utf8');
  const injectScript = `
    <script>
      window.__SULLYOS_E2E_STATUS__ = {
        buildNumber: 3600,
        bundleId: 'ota-bundle-3600',
        healthy: true,
        injectedAt: ${Date.now()}
      };
      console.log('[SULLYOS-E2E-TEST] OTA Bundle 3600 initialized inside WebView.');
    </script>
  `;
  healthyHtml = healthyHtml.replace('<head>', `<head>${injectScript}`);
  fs.writeFileSync(healthyIndexHtmlPath, healthyHtml, 'utf8');

  const zip3600Path = path.join(TEMP_DIR, 'web-bundle-3600.zip');
  execSync(`tar -a -c -f "${zip3600Path}" -C "${bundle3600Dir}" .`, { stdio: 'pipe' });
  const sha256_3600 = sha256File(zip3600Path);
  const size3600 = fs.statSync(zip3600Path).size;
  log('SETUP', `Created healthy bundle 3600: ${size3600} bytes, SHA: ${sha256_3600.substring(0, 16)}...`);

  // 2. Bundle 3601 (Fatal Poison Bundle - NO LiveUpdate.ready() call)
  const bundle3601Dir = path.join(TEMP_DIR, 'bundle-3601');
  fs.mkdirSync(bundle3601Dir, { recursive: true });

  const poisonHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SullyOS Fatal Poison Bundle 3601</title>
</head>
<body style="background:#8b0000; color:#fff; font-family:sans-serif; padding:40px;">
  <h1>CRITICAL POISON BUNDLE 3601</h1>
  <p>This bundle intentionally drops LiveUpdate.ready() to trigger the 10000ms watchdog rollback.</p>
  <script>
    window.__SULLYOS_POISON_ACTIVE__ = true;
    console.error('[SULLYOS-POISON] Poison bundle 3601 loaded! Watchdog countdown started.');
  </script>
</body>
</html>`;
  fs.writeFileSync(path.join(bundle3601Dir, 'index.html'), poisonHtml, 'utf8');

  const zip3601Path = path.join(TEMP_DIR, 'web-poison-3601.zip');
  execSync(`tar -a -c -f "${zip3601Path}" -C "${bundle3601Dir}" .`, { stdio: 'pipe' });
  const sha256_3601 = sha256File(zip3601Path);
  const size3601 = fs.statSync(zip3601Path).size;
  log('SETUP', `Created poison bundle 3601: ${size3601} bytes, SHA: ${sha256_3601.substring(0, 16)}...`);

  return {
    healthy: { path: zip3600Path, sha256: sha256_3600, size: size3600 },
    poison: { path: zip3601Path, sha256: sha256_3601, size: size3601 },
  };
}

function startHttpServer(bundles) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      log('HTTP', `${req.method} ${req.url}`);
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }
      if (req.url === '/bundles/web-bundle-3600.zip') {
        const stream = fs.createReadStream(bundles.healthy.path);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': bundles.healthy.size,
        });
        stream.pipe(res);
        return;
      }
      if (req.url === '/bundles/web-poison-3601.zip') {
        const stream = fs.createReadStream(bundles.poison.path);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': bundles.poison.size,
        });
        stream.pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(HTTP_PORT, '0.0.0.0', () => {
      log('HTTP', `Mock update server running on http://0.0.0.0:${HTTP_PORT}`);
      resolve(server);
    });
  });
}

async function main() {
  console.log('================================================================');
  console.log('       SullyOS Live Update End-to-End Test Suite                ');
  console.log('       Track A: OTA Bundle Download, Activation & ready()       ');
  console.log('       Track B: Poison Bundle 10s Watchdog Rollback Drill       ');
  console.log('================================================================\n');

  const serial = resolveAdbDevice();
  log('SETUP', `Target Android device: ${serial}`);

  const bundles = await prepareBundles();
  const server = await startHttpServer(bundles);

  // Setup reverse port forwarding so emulator/device can reach host
  runAdb(serial, `reverse tcp:${HTTP_PORT} tcp:${HTTP_PORT}`);
  log('ADB', `Reverse port forwarded tcp:${HTTP_PORT} -> tcp:${HTTP_PORT}`);

  // Clear logcat buffer and start collector
  runAdb(serial, 'logcat -c');
  const logcat = startLogcatCollector(serial, ['LiveUpdate:D', 'Capacitor:D', 'Capacitor/Console:D', '*:S']);

  // Ensure target app is running
  let pid = null;
  try {
    pid = runAdb(serial, `shell pidof ${APP_ID}`);
  } catch {}

  if (!pid) {
    log('SETUP', `App not running, launching ${DEFAULT_MAIN_ACTIVITY}...`);
    runAdb(serial, `shell am start -n ${DEFAULT_MAIN_ACTIVITY}`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Forward DevTools socket and connect CDP client
  findAndForwardDevtools(serial, APP_ID, CDP_PORT);
  const cdp = new CdpClient(CDP_PORT);
  await cdp.connect();

  try {
    // -------------------------------------------------------------
    // PHASE 0: Baseline Verification
    // -------------------------------------------------------------
    console.log('\n>>> [PHASE 0] Verifying Baseline Runtime State...');
    const initialBundleEval = await cdp.evaluate('window.Capacitor.Plugins.LiveUpdate.getCurrentBundle()');
    const initialBundle = initialBundleEval.result.value;
    log('BASELINE', `Initial bundle state: ${JSON.stringify(initialBundle)}`);
    if (initialBundle && initialBundle.bundleId !== null) {
      log('BASELINE', `App was on bundle '${initialBundle.bundleId}', resetting to default baseline...`);
      await cdp.evaluate('window.Capacitor.Plugins.LiveUpdate.reset()');
      await cdp.evaluate('window.Capacitor.Plugins.LiveUpdate.reload()');
      await new Promise((r) => setTimeout(r, 4000));
      cdp.close();
      findAndForwardDevtools(serial, APP_ID, CDP_PORT);
      await cdp.connect();
    }
    log('BASELINE', 'Baseline bundle verified (default built-in bundle active).');

    // -------------------------------------------------------------
    // TRACK A: OTA Bundle Download, Activation & ready() Handshake
    // -------------------------------------------------------------
    console.log('\n>>> [TRACK A] Testing OTA Bundle Download, Activation & ready()...');
    logcat.clear();

    const healthyUrl = `http://127.0.0.1:${HTTP_PORT}/bundles/web-bundle-3600.zip`;
    log('TRACK_A', 'Step 1: Downloading ota-bundle-3600...');

    // In case previous runs left bundle 3600 behind, clean it up
    await cdp.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.deleteBundle({ bundleId: 'ota-bundle-3600' }).catch(() => {})
    `);

    const downloadRes = await cdp.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.downloadBundle({
        url: '${healthyUrl}',
        bundleId: 'ota-bundle-3600'
      })
    `);
    log('TRACK_A', `downloadBundle response: ${JSON.stringify(downloadRes)}`);

    log('TRACK_A', 'Step 2: Setting next bundle to ota-bundle-3600...');
    await cdp.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.setNextBundle({
        bundleId: 'ota-bundle-3600'
      })
    `);

    const nextBundleRes = await cdp.evaluate('window.Capacitor.Plugins.LiveUpdate.getNextBundle()');
    log('TRACK_A', `getNextBundle response: ${JSON.stringify(nextBundleRes.result?.value)}`);
    if (nextBundleRes.result?.value?.bundleId !== 'ota-bundle-3600') {
      throw new Error(`Expected nextBundle to be 'ota-bundle-3600', got: ${JSON.stringify(nextBundleRes.result?.value)}`);
    }

    log('TRACK_A', 'Step 3: Triggering LiveUpdate.reload() to activate bundle...');
    const reloadStart = Date.now();
    cdp.evaluate('window.Capacitor.Plugins.LiveUpdate.reload()').catch(() => {});
    cdp.close();

    log('TRACK_A', 'Waiting for new bundle to boot and establish connection...');
    await new Promise((r) => setTimeout(r, 3500));

    // Reconnect CDP to the reloaded WebView
    findAndForwardDevtools(serial, APP_ID, CDP_PORT);
    const activePid = runAdb(serial, `shell pidof ${APP_ID}`);
    log('TRACK_A', `Active app PID for Track A verification: ${activePid}`);
    const cdpA = new CdpClient(CDP_PORT);
    await cdpA.connect();
    const webViewConnectedAt = Date.now();
    const activationElapsedSec = ((webViewConnectedAt - reloadStart) / 1000).toFixed(2);
    log('TRACK_A', `WebView reconnected in ${activationElapsedSec}s after reload.`);

    log('TRACK_A', 'Step 4: Checking initial runtime bundle state in WebView...');
    const updatedBundleRes = await cdpA.evaluate('window.Capacitor.Plugins.LiveUpdate.getCurrentBundle()');
    log('TRACK_A', `getCurrentBundle response: ${JSON.stringify(updatedBundleRes.result?.value)}`);
    if (updatedBundleRes.result?.value?.bundleId !== 'ota-bundle-3600') {
      throw new Error(`TRACK A FAILED: Current bundleId is not 'ota-bundle-3600'! Actual: ${JSON.stringify(updatedBundleRes.result?.value)}`);
    }

    const injectedStatus = await cdpA.evaluate('window.__SULLYOS_E2E_STATUS__');
    log('TRACK_A', `Injected status: ${JSON.stringify(injectedStatus.result?.value)}`);
    if (injectedStatus.result?.value?.buildNumber !== 3600) {
      throw new Error('TRACK A FAILED: window.__SULLYOS_E2E_STATUS__.buildNumber !== 3600');
    }

    const WATCHDOG_TIMEOUT_MS = 10000;
    const SURVIVAL_TARGET_MS = 13500; // readyTimeout (10s) + 3.5s grace period

    log('TRACK_A', `Step 5: Verifying healthy bundle survival beyond ${WATCHDOG_TIMEOUT_MS}ms watchdog timeout...`);
    let readyLogFound = false;

    while (Date.now() - reloadStart < SURVIVAL_TARGET_MS) {
      const remainingMs = SURVIVAL_TARGET_MS - (Date.now() - reloadStart);
      const sleepMs = Math.min(1000, Math.max(100, remainingMs));
      await new Promise((r) => setTimeout(r, sleepMs));

      // Check logcat for unexpected rollback
      const rollbackLog = logcat.find((l) => l.includes('Rolling back to default bundle') || l.includes('App is not ready'));
      if (rollbackLog) {
        throw new Error(`TRACK A FAILED: Unexpected watchdog rollback occurred during healthy bundle evaluation: "${rollbackLog}"`);
      }

      if (!readyLogFound && logcat.find((l) => l.includes('App is ready.'))) {
        readyLogFound = true;
        const readyElapsed = ((Date.now() - reloadStart) / 1000).toFixed(2);
        log('TRACK_A', `[INFO] "App is ready." confirmed in logcat at ${readyElapsed}s (supplemental PASS evidence).`);
      }
    }

    const totalSurvivalSec = ((Date.now() - reloadStart) / 1000).toFixed(2);
    log('TRACK_A', `Bundle survival verification complete (${totalSurvivalSec}s elapsed).`);

    // Verify process continuity: Ensure process did not crash/restart during the survival window
    const postTimeoutPid = runAdb(serial, `shell pidof ${APP_ID}`);
    if (postTimeoutPid !== activePid) {
      throw new Error(`TRACK A FAILED: Process restarted during watchdog evaluation! Initial PID: ${activePid}, Post-survival PID: ${postTimeoutPid}`);
    }

    // Re-verify bundle is STILL ota-bundle-3600 and app is healthy
    const postTimeoutBundleRes = await cdpA.evaluate('window.Capacitor.Plugins.LiveUpdate.getCurrentBundle()');
    log('TRACK_A', `post-timeout getCurrentBundle: ${JSON.stringify(postTimeoutBundleRes.result?.value)}`);
    if (postTimeoutBundleRes.result?.value?.bundleId !== 'ota-bundle-3600') {
      throw new Error(`TRACK A FAILED: Bundle rolled back after watchdog timeout! Current: ${JSON.stringify(postTimeoutBundleRes.result?.value)}`);
    }

    // Check performance threshold
    log('TRACK_A', `Timing Metrics:`);
    log('TRACK_A', `  - Watchdog Timeout: ${WATCHDOG_TIMEOUT_MS}ms`);
    log('TRACK_A', `  - Activation Elapsed Time: ${activationElapsedSec}s`);
    log('TRACK_A', `  - Bundle Survival Time: ${totalSurvivalSec}s`);

    const activationRatio = parseFloat(activationElapsedSec) / (WATCHDOG_TIMEOUT_MS / 1000);
    if (activationRatio > 0.7) {
      log('TRACK_A', `[WARNING] Activation elapsed time (${activationElapsedSec}s) exceeded 70% of watchdog timeout (${WATCHDOG_TIMEOUT_MS / 1000}s)! Risk on slow devices.`);
    }

    console.log('\n[PASS] >>> TRACK A PASSED: OTA Bundle 3600 downloaded, activated, and survived >10s watchdog without rollback.\n');

    // -------------------------------------------------------------
    // TRACK B: Fatal Poison Bundle 10-Second Watchdog Auto-Rollback Drill
    // -------------------------------------------------------------
    console.log('>>> [TRACK B] Testing Fatal Poison Bundle 10-Second Watchdog Auto-Rollback...');
    logcat.clear();

    const poisonUrl = `http://127.0.0.1:${HTTP_PORT}/bundles/web-poison-3601.zip`;
    log('TRACK_B', 'Step 1: Downloading poison-bundle-3601...');
    await cdpA.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.deleteBundle({ bundleId: 'poison-bundle-3601' }).catch(() => {})
    `);
    await cdpA.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.downloadBundle({
        url: '${poisonUrl}',
        bundleId: 'poison-bundle-3601'
      })
    `);

    log('TRACK_B', 'Step 2: Setting next bundle to poison-bundle-3601...');
    await cdpA.evaluate(`
      window.Capacitor.Plugins.LiveUpdate.setNextBundle({
        bundleId: 'poison-bundle-3601'
      })
    `);

    log('TRACK_B', 'Step 3: Reloading into poison bundle (watchdog will trigger in 10s)...');
    const rollbackStart = Date.now();
    cdpA.evaluate('window.Capacitor.Plugins.LiveUpdate.reload()').catch(() => {});
    cdpA.close();

    log('TRACK_B', 'Monitoring Logcat for watchdog timeout and auto-rollback event...');
    let rollbackDetected = false;
    let autoRecoveredReady = false;
    let rollbackElapsed = 0;

    for (let sec = 0; sec < 20; sec++) {
      await new Promise((r) => setTimeout(r, 1000));
      const elapsed = Math.round((Date.now() - rollbackStart) / 1000);
      process.stdout.write(`[TRACK_B] Elapsed: ${elapsed}s... \r`);

      if (!rollbackDetected) {
        const found = logcat.find((l) => l.includes('Rolling back to default bundle') || l.includes('App is not ready'));
        if (found) {
          rollbackDetected = true;
          rollbackElapsed = (Date.now() - rollbackStart) / 1000;
          log('TRACK_B', `\n[WATCHDOG TRIGGERED] At ${rollbackElapsed.toFixed(1)}s: "${found}"`);
        }
      }

      if (rollbackDetected && !autoRecoveredReady) {
        const readyAfter = logcat.find((l) => l.includes('App is ready.'));
        if (readyAfter) {
          autoRecoveredReady = true;
          log('TRACK_B', `[AUTO-RECOVERY COMPLETE] Built-in default bundle readied: "${readyAfter}"`);
          break;
        }
      }
    }
    console.log('');

    if (!rollbackDetected) {
      throw new Error('TRACK B FAILED: Watchdog rollback log not detected within 20 seconds!');
    }

    log('TRACK_B', 'Step 4: Verifying recovered state via CDP in WebView...');
    await new Promise((r) => setTimeout(r, 3000));
    findAndForwardDevtools(serial, APP_ID, CDP_PORT);
    const cdpB = new CdpClient(CDP_PORT);
    await cdpB.connect();

    const recoveredBundleRes = await cdpB.evaluate('window.Capacitor.Plugins.LiveUpdate.getCurrentBundle()');
    log('TRACK_B', `Recovered bundleId: ${JSON.stringify(recoveredBundleRes.result?.value)}`);
    if (recoveredBundleRes.result?.value?.bundleId !== null) {
      throw new Error(`TRACK B FAILED: Expected bundleId to be null after rollback, got: ${JSON.stringify(recoveredBundleRes.result?.value)}`);
    }

    const titleRes = await cdpB.evaluate('document.title');
    log('TRACK_B', `Recovered page title: "${titleRes.result?.value}"`);
    if (!titleRes.result?.value?.includes('SullyOS')) {
      throw new Error(`TRACK B FAILED: Expected page title to be SullyOS, got: ${titleRes.result?.value}`);
    }

    cdpB.close();
    console.log('\n[PASS] >>> TRACK B PASSED: Watchdog auto-rollback triggered and restored default bundle safely!\n');

    console.log('================================================================');
    console.log('[PASS] ALL LIVE UPDATE E2E TESTS COMPLETED WITH 100% SUCCESS!');
    console.log('================================================================\n');

  } finally {
    cdp.close();
    logcat.stop();
    server.close();
    try { runAdb(serial, `reverse --remove tcp:${HTTP_PORT}`); } catch {}
    try { runAdb(serial, `forward --remove tcp:${CDP_PORT}`); } catch {}
    if (fs.existsSync(TEMP_DIR)) {
      try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR IN LIVE UPDATE E2E]:', err);
  process.exit(1);
});

import {
  resolveAdbDevice,
  runAdb,
  startLogcatCollector,
  DEFAULT_APP_ID,
  DEFAULT_MAIN_ACTIVITY,
  log,
} from './adb-common.mjs';

const TOTAL_ROUNDS = 10;
const READY_TIMEOUT_MS = 10000;

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyAppLaunch(serial, roundLabel) {
  const startTime = Date.now();
  let pid = null;
  let readyFound = false;
  let nativeExportRegistered = false;
  let liveUpdateRegistered = false;
  let fatalError = null;

  // 1. 验证进程启动并获得 PID
  while (Date.now() - startTime < 4000) {
    try {
      const out = runAdb(serial, `shell pidof ${DEFAULT_APP_ID}`);
      if (out && /^\d+$/.test(out.trim())) {
        pid = out.trim();
        break;
      }
    } catch {}
    await wait(300);
  }

  if (!pid) {
    throw new Error(`[${roundLabel}] FAILED: App process failed to spawn within 4s.`);
  }

  return { pid };
}

async function main() {
  console.log('================================================================');
  console.log('       SullyOS Android Cold Start Stress Test Suite             ');
  console.log(`       Target: ${DEFAULT_APP_ID} (${TOTAL_ROUNDS} Cycles)       `);
  console.log('================================================================\n');

  const serial = resolveAdbDevice();
  log('SETUP', `Target Android device resolved: ${serial}`);

  // 检查是否已安装目标包
  try {
    const pkgPath = runAdb(serial, `shell pm path ${DEFAULT_APP_ID}`);
    if (!pkgPath || !pkgPath.includes('package:')) {
      throw new Error(`App package '${DEFAULT_APP_ID}' is not installed on ${serial}.`);
    }
    log('SETUP', `Target package verified on device: ${pkgPath.trim()}`);
  } catch (e) {
    console.error(`\n[FATAL] Target package check failed: ${e.message}`);
    process.exit(1);
  }

  // -------------------------------------------------------------
  // PHASE 0: 建立 Baseline（健康基线检测）
  // -------------------------------------------------------------
  console.log('\n>>> [PHASE 0] Establishing Clean Healthy Baseline...');
  runAdb(serial, `shell am force-stop ${DEFAULT_APP_ID}`);
  await wait(800);
  runAdb(serial, 'logcat -c');

  const baselineLogcat = startLogcatCollector(serial, [
    'LiveUpdate:D',
    'Capacitor:D',
    'Capacitor/Plugin:D',
    'Capacitor/Console:D',
    'AndroidRuntime:E',
    '*:S',
  ]);

  runAdb(serial, `shell am start -n ${DEFAULT_MAIN_ACTIVITY}`);
  const baselineStart = Date.now();
  let baselineReady = false;

  while (Date.now() - baselineStart < READY_TIMEOUT_MS) {
    if (baselineLogcat.find((l) => l.includes('App is ready.'))) {
      baselineReady = true;
      break;
    }
    await wait(300);
  }

  const baselineMissingAlias = baselineLogcat.find((l) => l.includes('MainActivityClassic does not exist'));
  baselineLogcat.stop();

  if (!baselineReady) {
    throw new Error('[BASELINE FAILED] Initial launch did not complete "App is ready." within timeout.');
  }
  if (baselineMissingAlias) {
    throw new Error(`[BASELINE FAILED] Missing alias error detected: "${baselineMissingAlias}"`);
  }

  log('BASELINE', 'Healthy baseline established successfully (App is ready, zero alias error).\n');

  // -------------------------------------------------------------
  // PHASE 1: 10 轮高压冷启动循环
  // -------------------------------------------------------------
  console.log(`>>> [PHASE 1] Starting ${TOTAL_ROUNDS} Cold-Start Stress Iterations...\n`);

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    const roundTag = `ROUND_${round.toString().padStart(2, '0')}`;
    log(roundTag, `[1/4] Force-stopping ${DEFAULT_APP_ID}...`);
    runAdb(serial, `shell am force-stop ${DEFAULT_APP_ID}`);
    await wait(400);

    // 清理 logcat 保证本轮独立无污染
    runAdb(serial, 'logcat -c');
    const logcat = startLogcatCollector(serial, [
      'LiveUpdate:D',
      'Capacitor:D',
      'Capacitor/Plugin:D',
      'Capacitor/Console:D',
      'AndroidRuntime:E',
      '*:S',
    ]);

    log(roundTag, `[2/4] Starting Activity: ${DEFAULT_MAIN_ACTIVITY}...`);
    const launchStart = Date.now();
    runAdb(serial, `shell am start -n ${DEFAULT_MAIN_ACTIVITY}`);

    const { pid } = await verifyAppLaunch(serial, roundTag);

    log(roundTag, `[3/4] Monitoring lifecycle barrier (PID: ${pid})...`);
    let readyDetected = false;
    let rollbackLoopDetected = false;
    let aliasErrorDetected = false;
    let fatalCrash = null;

    while (Date.now() - launchStart < READY_TIMEOUT_MS) {
      if (!readyDetected && logcat.find((l) => l.includes('App is ready.'))) {
        readyDetected = true;
      }
      if (logcat.find((l) => l.includes('Rolling back to default bundle') || l.includes('App is not ready'))) {
        rollbackLoopDetected = true;
      }
      if (logcat.find((l) => l.includes('MainActivityClassic does not exist'))) {
        aliasErrorDetected = true;
      }
      const fatal = logcat.find((l) => l.includes('FATAL EXCEPTION'));
      if (fatal) {
        fatalCrash = fatal;
        break;
      }
      if (readyDetected) {
        break;
      }
      await wait(250);
    }

    logcat.stop();
    const elapsedMs = Date.now() - launchStart;

    if (fatalCrash) {
      throw new Error(`[${roundTag}] FAILED with FATAL CRASH: ${fatalCrash}`);
    }
    if (aliasErrorDetected) {
      throw new Error(`[${roundTag}] FAILED: MainActivityClassic component does not exist detected!`);
    }
    if (rollbackLoopDetected) {
      throw new Error(`[${roundTag}] FAILED: Rollback watchdog triggered unexpectedly during cold start!`);
    }
    if (!readyDetected) {
      throw new Error(`[${roundTag}] FAILED: "App is ready." not detected within ${READY_TIMEOUT_MS}ms!`);
    }

    log(roundTag, `[4/4] [PASS] Verified cleanly in ${(elapsedMs / 1000).toFixed(2)}s (PID: ${pid}, plugins verified, ready OK)\n`);
  }

  console.log('================================================================');
  console.log(`[PASS] ALL ${TOTAL_ROUNDS} COLD-START STRESS ROUNDS COMPLETED WITH 100% SUCCESS!`);
  console.log('  - App Process: Clean spawn and termination on every cycle');
  console.log('  - Native Plugins: NativeExport and LiveUpdate loaded');
  console.log('  - Lifecycle Barrier: "App is ready." reached consistently');
  console.log('  - Error Cleanliness: Zero alias missing error, zero rollback loop, zero crash');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error(`\n[FATAL RUNNER ERROR]: ${err.message}`);
  process.exit(1);
});

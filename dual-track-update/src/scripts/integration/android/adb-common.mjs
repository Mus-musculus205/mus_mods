import http from 'node:http';
import { execSync, spawn } from 'node:child_process';

export const DEFAULT_APP_ID = 'com.example.sullyos';
export const DEFAULT_MAIN_ACTIVITY = 'com.example.sullyos/com.aetheros.simulator.MainActivity';
export const DEFAULT_CDP_PORT = 9222;

export function log(tag, msg) {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] [${tag}] ${msg}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 严格解析 Android 目标设备序列号：
 * 1. 优先读取 process.env.ANDROID_SERIAL
 * 2. 其次读取命令行 --serial=<val>
 * 3. 自动探测 adb devices：
 *    - 恰好 1 台在线设备：自动选用并提示
 *    - 0 台设备：清晰报错退出，不静默等待或失败
 *    - 多台设备：要求显式指定，列出所有候选设备后安全退出，不偷偷选错
 */
export function resolveAdbDevice() {
  let targetSerial = process.env.ANDROID_SERIAL?.trim();

  if (!targetSerial) {
    const cliArg = process.argv.find((arg) => arg.startsWith('--serial='));
    if (cliArg) {
      targetSerial = cliArg.split('=')[1].trim();
    }
  }

  if (targetSerial) {
    if (targetSerial.includes(':')) {
      for (let i = 0; i < 5; i++) {
        try {
          execSync(`adb connect ${targetSerial}`, { stdio: 'pipe', timeout: 5000 });
          execSync(`adb -s ${targetSerial} wait-for-device`, { stdio: 'pipe', timeout: 5000 });
          break;
        } catch {}
      }
    }
    return targetSerial;
  }

  let devicesOutput = '';
  try {
    devicesOutput = execSync('adb devices', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (err) {
    console.error(`[ADB ERROR] Failed to run 'adb devices': ${err.message}`);
    process.exit(1);
  }

  const lines = devicesOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  const connected = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') {
      connected.push(parts[0]);
    }
  }

  if (connected.length === 0) {
    console.error('[ADB ERROR] No connected Android devices or emulators found.');
    console.error('Please launch an emulator/device or run `adb connect <host:port>` first.');
    process.exit(1);
  }

  if (connected.length === 1) {
    log('DEVICE', `Auto-detected single connected Android device: ${connected[0]}`);
    return connected[0];
  }

  console.error('[ADB ERROR] Multiple Android devices detected. You must specify target device explicitly:');
  connected.forEach((d) => console.error(`  - ${d}`));
  console.error('\nUsage:');
  console.error('  $env:ANDROID_SERIAL="<device>" pnpm <script>');
  console.error('  or: pnpm <script> --serial=<device>');
  process.exit(1);
}

export function runAdb(serial, cmd, timeoutMs = 15000) {
  const fullCmd = `adb -s ${serial} ${cmd}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return execSync(fullCmd, { encoding: 'utf8', timeout: timeoutMs }).trim();
    } catch (err) {
      const errText = `${err.message || ''} ${err.stderr || ''} ${err.stdout || ''}`;
      if (errText.includes('device offline') || errText.includes('not found') || errText.includes('closed')) {
        if (serial.includes(':')) {
          try {
            execSync(`adb disconnect ${serial}`, { stdio: 'pipe', timeout: 5000 });
            execSync(`adb connect ${serial}`, { stdio: 'pipe', timeout: 5000 });
            execSync(`adb -s ${serial} wait-for-device`, { stdio: 'pipe', timeout: 5000 });
          } catch {}
          continue;
        }
      }
      throw err;
    }
  }
  return execSync(fullCmd, { encoding: 'utf8', timeout: timeoutMs }).trim();
}

export class CdpClient {
  constructor(port = DEFAULT_CDP_PORT) {
    this.port = port;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }

  async connect(retries = 15, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json`);
        const targets = await res.json();
        const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget) {
          log('CDP', `Page target found: ${pageTarget.title || 'untitled'} (${pageTarget.url})`);
          await this._connectWs(pageTarget.webSocketDebuggerUrl);
          return;
        }
      } catch {
        // Wait and retry
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`Failed to connect to DevTools CDP on port ${this.port} after ${retries} retries.`);
  }

  _connectWs(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        log('CDP', 'WebSocket debugging connection established.');
        resolve();
      };
      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = () => {
        log('CDP', 'WebSocket debugging connection closed.');
      };
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id && this.pending.has(data.id)) {
            const { resolve: res, reject: rej } = this.pending.get(data.id);
            this.pending.delete(data.id);
            if (data.error) rej(new Error(data.error.message || JSON.stringify(data.error)));
            else res(data.result);
          }
        } catch (e) {
          log('CDP', `Failed to parse CDP message: ${e.message}`);
        }
      };
    });
  }

  evaluate(expression, awaitPromise = true) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise,
          returnByValue: true,
        },
      }));
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

export function findAndForwardDevtools(serial, appId = DEFAULT_APP_ID, cdpPort = DEFAULT_CDP_PORT, retries = 15) {
  let pid = null;
  for (let i = 0; i < retries; i++) {
    try {
      const out = runAdb(serial, `shell pidof ${appId}`);
      if (out && /^\d+$/.test(out.trim())) {
        pid = out.trim();
        break;
      }
    } catch {}
    sleepSync(500);
    }

  if (!pid) {
    throw new Error(`App ${appId} is not running (no PID found).`);
  }
  log('ADB', `App ${appId} is active with PID: ${pid}`);

  let socketName = null;
  for (let i = 0; i < retries; i++) {
    try {
      const unixSockets = runAdb(serial, 'shell cat /proc/net/unix');
      const match = unixSockets.match(new RegExp(`@(webview_devtools_remote_${pid})`));
      if (match) {
        socketName = match[1];
        break;
      }
    } catch {}
    sleepSync(500);
  }

  if (!socketName) {
    throw new Error(`DevTools unix socket not found for PID ${pid}`);
  }
  log('ADB', `Discovered DevTools socket: @${socketName}`);

  runAdb(serial, `forward tcp:${cdpPort} localabstract:${socketName}`);
  log('ADB', `Forwarded tcp:${cdpPort} -> localabstract:${socketName}`);
}

export function startLogcatCollector(serial, filterSpecs = ['LiveUpdate:D', 'Capacitor:D', 'Capacitor/Plugin:D', 'Capacitor/Console:D', '*:S']) {
  const logLines = [];
  const logcat = spawn('adb', ['-s', serial, 'logcat', '-v', 'time', ...filterSpecs]);

  logcat.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      logLines.push(line);
    }
  });

  return {
    lines: logLines,
    stop: () => logcat.kill(),
    find: (predicate) => logLines.find(predicate),
    filter: (predicate) => logLines.filter(predicate),
    clear: () => { logLines.length = 0; },
  };
}

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/entry.js
var entry_exports = {};
__export(entry_exports, {
  default: () => entry_default
});
module.exports = __toCommonJS(entry_exports);
var import_node_path7 = require("node:path");

// src/endpoints.js
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");
var FORMAT_VERSION = 1;
var PORT_RANGE_START = 43110;
var PORT_RANGE_SIZE = 40;
function createEndpointStore({ path, logger } = {}) {
  let entries = {};
  const claimedInProcess = /* @__PURE__ */ new Set();
  const load = () => {
    const tmp = `${path}.tmp`;
    try {
      if ((0, import_node_fs.existsSync)(tmp)) (0, import_node_fs.unlinkSync)(tmp);
    } catch {
    }
    if (!(0, import_node_fs.existsSync)(path)) return;
    try {
      const parsed = JSON.parse((0, import_node_fs.readFileSync)(path, "utf8"));
      if (parsed?.version !== FORMAT_VERSION || typeof parsed.entries !== "object" || parsed.entries === null) return;
      entries = parsed.entries;
    } catch (error) {
      logger?.warn?.("ide-account-bridge: \u7AEF\u70B9\u7F13\u5B58\u65E0\u6CD5\u89E3\u6790\uFF0C\u5C06\u91CD\u65B0\u751F\u6210", error instanceof Error ? error.message : String(error));
    }
  };
  const save = () => {
    try {
      (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(path), { recursive: true });
      const tmp = `${path}.tmp`;
      (0, import_node_fs.writeFileSync)(tmp, JSON.stringify({ version: FORMAT_VERSION, entries }, null, 2), { encoding: "utf8", mode: 384 });
      (0, import_node_fs.renameSync)(tmp, path);
    } catch (error) {
      logger?.warn?.("ide-account-bridge: \u7AEF\u70B9\u7F13\u5B58\u5199\u5165\u5931\u8D25\uFF08\u7AEF\u53E3\u4E0E token \u5C06\u65E0\u6CD5\u8DE8\u91CD\u542F\u4FDD\u6301\uFF09", error instanceof Error ? error.message : String(error));
    }
  };
  load();
  const recordFor = (regionId) => {
    const existing = entries[regionId];
    return existing !== void 0 && typeof existing === "object" && existing !== null ? existing : {};
  };
  return {
    /**
     * The bearer token for a region, minted once and then reused.
     *
     * @param regionId - the region id (`qoder-cn`, `qoder`, `cn`, `ai`).
     * @returns a stable token.
     */
    tokenFor(regionId) {
      const record2 = recordFor(regionId);
      if (typeof record2.token === "string" && record2.token.length > 0) return record2.token;
      const token = (0, import_node_crypto.randomBytes)(32).toString("base64url");
      entries[regionId] = { ...record2, token };
      save();
      return token;
    },
    /**
     * A port to try first, so a stable port is reused across restarts.
     *
     * Deterministic per region rather than stored, so a region that has never
     * started still gets a sensible first guess; the caller records whatever it
     * actually binds. `recordPort` is what makes it stick.
     *
     * Ports handed out earlier in this process are skipped: the two groups
     * (Qoder, Trae) number their regions from zero independently, so without
     * this the second group's first region would collide with the first group's
     * and fall back to a random port on a fresh install.
     *
     * @param regionId - the region id.
     * @param index - the region's position within its own group.
     * @returns a port number to attempt.
     */
    preferredPortFor(regionId, index = 0) {
      const record2 = recordFor(regionId);
      if (typeof record2.port === "number" && Number.isInteger(record2.port) && record2.port > 1024 && record2.port <= 65535) {
        claimedInProcess.add(record2.port);
        return record2.port;
      }
      for (let step = 0; step < PORT_RANGE_SIZE; step += 1) {
        const candidate = PORT_RANGE_START + (index + step) % PORT_RANGE_SIZE;
        if (!claimedInProcess.has(candidate)) {
          claimedInProcess.add(candidate);
          return candidate;
        }
      }
      return 0;
    },
    /**
     * Remember the port that actually bound, so the next start reuses it.
     *
     * @param regionId - the region id.
     * @param port - the bound port.
     */
    recordPort(regionId, port) {
      const record2 = recordFor(regionId);
      if (record2.port === port) return;
      entries[regionId] = { ...record2, port };
      save();
    },
    /** Everything currently known, for diagnostics. */
    snapshot() {
      return JSON.parse(JSON.stringify(entries));
    }
  };
}

// src/qoder/runtime.js
var import_node_path5 = require("node:path");

// src/qoder/lib/credentials.js
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
var import_node_crypto2 = require("node:crypto");
var import_node_sqlite = require("node:sqlite");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
var USER_INFO_KEY = "secret://aicoding.auth.userInfo";
var USER_PLAN_KEY = "secret://aicoding.auth.userPlan";
var CREDIT_USAGE_KEY = "secret://aicoding.auth.creditUsage";
var ZERO_BLOCK_BYTES = 64 * 1024;
var ZERO_RETRY_BACKOFF_MS = 50;
var OSCRYPT_MARKER = ".dsh-oscrypt";
var REGIONS = [
  {
    id: "qoder-cn",
    mode: "cn",
    displayName: "Qoder CN",
    appNames: ["QoderCN", "Qoder CN", "QoderWork CN"],
    // Qoder 0.3.x moved its user data to a `com.<vendor>.app.<channel>` Electron
    // directory and replaced the VS Code `state.vscdb` store with `auth.v1.dat`.
    // Both layouts are listed so a user who upgrades keeps working; the newer
    // one is tried first because that is where a freshly installed app writes.
    newAppNames: ["com.qodercn.app.stable"],
    baseUrl: "https://gateway.qoder.com.cn/",
    openApiUrl: "https://openapi.qoder.com.cn",
    centerUrl: "https://gateway.qoder.com.cn",
    manageUrl: "https://qoder.com.cn",
    patEnvNames: ["QODERCN_API_KEY", "QODERCN_PERSONAL_ACCESS_TOKEN", "QODERCN_PAT"]
  },
  {
    id: "qoder",
    mode: "global",
    displayName: "Qoder",
    appNames: ["Qoder", "QoderWork"],
    newAppNames: ["com.qoder.app.stable"],
    baseUrl: "https://api3.qoder.sh/",
    openApiUrl: "https://openapi.qoder.sh",
    centerUrl: "https://center.qoder.sh",
    manageUrl: "https://qoder.com",
    patEnvNames: ["QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"]
  }
];
var DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QoderDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$statePath = Join-Path $env:QODER_APP_DIR 'Local State'
$json = Get-Content $statePath -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ($raw.Length -le 5) { throw 'encrypted_key too short' }
$key = [QoderDpapi]::U($raw[5..($raw.Length - 1)])
# Hand the key off through an exclusive handle (no other process on the box
# can read it while it is on disk) and, before any secret byte touches the
# file, restrict its ACL to the current user: the default inherited ACL of
# the temp directory follows the machine's policy, shared-drive TEMP included.
#
# The ACL is applied with the static File.SetAccessControl after the handle
# that created the file is closed. Applying it THROUGH the open handle (the
# previous shape) always fails: that handle was opened ReadWrite, which does
# not carry WRITE_DAC, so the driver answers ACCESS_DENIED \u2014 and widening the
# handle's access would let another process open the file in the gap anyway.
# The file is still EMPTY when the ACL lands, so no key byte exists before
# the restriction is in force; the handle is then reopened exclusive for the
# write. The type is FileSystemAccessRule \u2014 there is no "FileAccessRule" in
# .NET, and resolving a non-existent type aborts the script before the unwrap.
$fs = New-Object System.IO.FileStream($env:QODER_KEY_OUT, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
$fs.Dispose()
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.InheritanceFlags]::None,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)))
[System.IO.File]::SetAccessControl($env:QODER_KEY_OUT, $acl)
$fs = New-Object System.IO.FileStream($env:QODER_KEY_OUT, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
  $payload = [System.Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($key))
  $fs.Write($payload, 0, $payload.Length)
  $fs.Flush()
} finally {
  $fs.Dispose()
}
`;
var keyCache = /* @__PURE__ */ new Map();
var lastUnwrapFailure = /* @__PURE__ */ new Map();
var diagnosticSink;
function setCredentialDiagnosticSink(sink) {
  diagnosticSink = typeof sink === "function" ? sink : void 0;
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
  }
}
function reportCleanupFailure(message) {
  const where = diagnosticSink ?? ((text) => process.emitWarning(text));
  where(`dsh-connect-qoder: ${message}`);
}
process.on("exit", () => {
  for (const cached of keyCache.values()) cached?.fill(0);
});
async function oscryptKeyFor(appDir) {
  if (keyCache.has(appDir)) return keyCache.get(appDir);
  let key;
  let lastFailure;
  const statePath = (0, import_node_path2.join)(appDir, "Local State");
  if (!(0, import_node_fs2.existsSync)(statePath)) {
    lastFailure = "no Local State file";
  } else {
    let dir;
    try {
      dir = (0, import_node_fs2.mkdtempSync)((0, import_node_path2.join)((0, import_node_os.tmpdir)(), "qoder-oscrypt-"));
      (0, import_node_fs2.writeFileSync)((0, import_node_path2.join)(dir, OSCRYPT_MARKER), "");
      const outFile = (0, import_node_path2.join)(dir, "key.b64");
      await execFileAsync(
        systemPowershell(),
        ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: 3e4,
          env: unwrapEnv(appDir, outFile)
        }
      );
      const text = (0, import_node_fs2.readFileSync)(outFile, "utf8").trim();
      if (text.length > 0) {
        const candidate = Buffer.from(text, "base64");
        if (candidate.length === 32) key = candidate;
        else lastFailure = `Local State unwrapped to ${candidate.length} bytes, expected 32`;
      } else {
        lastFailure = "the unwrap produced an empty key file";
      }
    } catch (error) {
      lastFailure = error?.status !== void 0 ? `PowerShell exited ${error.status}${error.signal ? ` (${error.signal})` : ""}` : error?.message ?? String(error);
    } finally {
      if (dir !== void 0) {
        zeroOutFile((0, import_node_path2.join)(dir, "key.b64"));
        try {
          (0, import_node_fs2.rmSync)(dir, { recursive: true, force: true });
        } catch (error) {
          reportCleanupFailure(
            `could not remove the credential temp dir ${dir}: ${error?.message ?? error}`
          );
        }
      }
    }
  }
  if (key === void 0) {
    lastUnwrapFailure.set(appDir, lastFailure);
    if (lastFailure !== "no Local State file") {
      const where = diagnosticSink ?? ((message) => process.emitWarning(message));
      where(`dsh-connect-qoder: could not unwrap the OSCrypt key for ${appDir}: ${lastFailure}`);
    }
    return void 0;
  }
  lastUnwrapFailure.delete(appDir);
  keyCache.set(appDir, key);
  return key;
}
function systemPowershell() {
  return (0, import_node_path2.join)(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}
var PS_ENV_ALLOWLIST = [
  "SYSTEMDRIVE",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "COMSPEC",
  "PATHEXT",
  "PATH",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "USERNAME",
  "USERPROFILE",
  "LOGONSERVER"
];
function unwrapEnv(appDir, outFile) {
  const allowed = new Set(PS_ENV_ALLOWLIST.map((name) => name.toLowerCase()));
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (allowed.has(name.toLowerCase())) env[name] = value;
  }
  env.QODER_APP_DIR = appDir;
  env.QODER_KEY_OUT = outFile;
  return env;
}
function zeroOutFile(file, attempts = 4) {
  let stat2;
  try {
    stat2 = (0, import_node_fs2.lstatSync)(file);
  } catch {
    return true;
  }
  if (!stat2.isFile()) {
    reportCleanupFailure(
      `refused to zero ${file}: not a plain file (mode ${(stat2.mode & 4095).toString(8)})`
    );
    return false;
  }
  if (stat2.size <= 0) return true;
  const size = stat2.size;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleepSync(ZERO_RETRY_BACKOFF_MS * attempt);
    let fd;
    try {
      fd = (0, import_node_fs2.openSync)(file, "r+");
    } catch (error) {
      if (!(0, import_node_fs2.existsSync)(file)) return true;
      lastError = error;
      continue;
    }
    try {
      const block = Buffer.alloc(Math.min(ZERO_BLOCK_BYTES, size));
      let offset = 0;
      while (offset < size) {
        const length = Math.min(block.length, size - offset);
        (0, import_node_fs2.writeSync)(fd, block, 0, length, offset);
        offset += length;
      }
      return true;
    } catch (error) {
      lastError = error;
    } finally {
      try {
        (0, import_node_fs2.closeSync)(fd);
      } catch {
      }
    }
  }
  try {
    (0, import_node_fs2.truncateSync)(file, 0);
  } catch {
  }
  if ((0, import_node_fs2.existsSync)(file) && currentSize(file) > 0) {
    reportCleanupFailure(
      `could not zero ${file} after ${attempts} attempts (${lastError?.message ?? "unknown"})`
    );
    return false;
  }
  return true;
}
function currentSize(file) {
  try {
    return (0, import_node_fs2.lstatSync)(file).size;
  } catch {
    return 0;
  }
}
function decryptOscrypt(blob, key) {
  if (blob.length < 3 + 12 + 16) return void 0;
  if (blob.subarray(0, 3).toString("latin1") !== "v10") return void 0;
  const body = blob.subarray(3);
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(12, body.length - 16);
  try {
    const decipher = (0, import_node_crypto2.createDecipheriv)("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return void 0;
  }
}
function readItem(dbPath, key) {
  const db = new import_node_sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
    if (row === void 0 || row.value === null || row.value === void 0) return void 0;
    const value = row.value;
    const text = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
    if (text.startsWith("{") && text.includes('"type":"Buffer"')) {
      try {
        return Buffer.from(JSON.parse(text).data);
      } catch {
        return text;
      }
    }
    return text;
  } finally {
    db.close();
  }
}
function readJsonSecret(dbPath, key, oscryptKey) {
  const raw = readItem(dbPath, key);
  if (raw === void 0 || typeof raw === "string") return void 0;
  const plain = decryptOscrypt(raw, oscryptKey);
  if (plain === void 0) return void 0;
  try {
    return JSON.parse(plain);
  } catch {
    return void 0;
  }
}
function stateDbCandidates(appDir) {
  return [
    (0, import_node_path2.join)(appDir, "User", "globalStorage", "state.vscdb"),
    (0, import_node_path2.join)(appDir, "User", "globalStorage", "state.vscdb.backup")
  ];
}
function machineIdFor(appDir, fallback) {
  for (const name of ["auth.machine-id", "machineid", "machineId"]) {
    const p = (0, import_node_path2.join)(appDir, name);
    if (!(0, import_node_fs2.existsSync)(p)) continue;
    const value = (0, import_node_fs2.readFileSync)(p, "utf8").trim();
    if (value.length > 0) return value;
  }
  return fallback;
}
function loadNewCredential(region, appDir, oscryptKey) {
  const file = (0, import_node_path2.join)(appDir, "auth.v1.dat");
  if (!(0, import_node_fs2.existsSync)(file)) return void 0;
  const plain = decryptOscrypt((0, import_node_fs2.readFileSync)(file), oscryptKey);
  if (plain === void 0) return void 0;
  let session;
  try {
    session = JSON.parse(plain);
  } catch {
    return void 0;
  }
  if (session === null || typeof session !== "object") return void 0;
  if (typeof session.token !== "string" || session.token.length === 0) return void 0;
  const user = session.user !== null && typeof session.user === "object" ? session.user : {};
  const userID = typeof user.id === "string" ? user.id : "";
  if (userID.length === 0) return void 0;
  const expiresAt = Date.parse(session.expiresAt);
  const refreshExpiresAt = Date.parse(session.refreshTokenExpiresAt);
  return {
    region: region.id,
    appName: (0, import_node_path2.basename)(appDir),
    userID,
    name: typeof user.name === "string" ? user.name : "",
    email: typeof user.email === "string" ? user.email : "",
    token: session.token,
    refreshToken: typeof session.refreshToken === "string" ? session.refreshToken : "",
    refreshTokenExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
    // The new layout does not publish these; they were only ever used for
    // display, and the catalog call supplies what routing actually needs.
    userType: "",
    userTag: "",
    machineID: machineIdFor(appDir, `dsh-connect-qoder-${region.id}`),
    source: "app",
    plan: void 0,
    usage: void 0
  };
}
async function loadCredential(region, appDataRoot) {
  for (const appName of region.newAppNames ?? []) {
    const appDir = (0, import_node_path2.join)(appDataRoot, appName);
    if (!(0, import_node_fs2.existsSync)(appDir)) continue;
    const oscryptKey = await oscryptKeyFor(appDir);
    if (oscryptKey === void 0) continue;
    const credential = safeRead(() => loadNewCredential(region, appDir, oscryptKey));
    if (credential !== void 0) return credential;
  }
  for (const appName of region.appNames) {
    const appDir = (0, import_node_path2.join)(appDataRoot, appName);
    if (!(0, import_node_fs2.existsSync)(appDir)) continue;
    const oscryptKey = await oscryptKeyFor(appDir);
    if (oscryptKey === void 0) continue;
    for (const dbPath of stateDbCandidates(appDir)) {
      if (!(0, import_node_fs2.existsSync)(dbPath)) continue;
      let userInfo;
      try {
        userInfo = readJsonSecret(dbPath, USER_INFO_KEY, oscryptKey);
      } catch {
        continue;
      }
      if (userInfo === void 0 || typeof userInfo.token !== "string" || userInfo.token.length === 0) continue;
      if (typeof userInfo.id !== "string" || userInfo.id.length === 0) continue;
      const expiresAt = Number(userInfo.expireTime);
      return {
        region: region.id,
        appName,
        userID: userInfo.id,
        name: typeof userInfo.name === "string" ? userInfo.name : "",
        email: typeof userInfo.email === "string" ? userInfo.email : "",
        token: userInfo.token,
        refreshToken: typeof userInfo.refreshToken === "string" ? userInfo.refreshToken : "",
        refreshTokenExpiresAt: Number(userInfo.refreshTokenExpireTime) || 0,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt <= Date.now() : false,
        userType: typeof userInfo.userType === "string" ? userInfo.userType : "",
        userTag: typeof userInfo.userTag === "string" ? userInfo.userTag : "",
        machineID: machineIdFor(appDir, `dsh-connect-qoder-${region.id}`),
        source: "app",
        plan: safeRead(() => readJsonSecret(dbPath, USER_PLAN_KEY, oscryptKey)),
        usage: safeRead(() => readJsonSecret(dbPath, CREDIT_USAGE_KEY, oscryptKey))
      };
    }
  }
  return void 0;
}
function safeRead(fn) {
  try {
    return fn();
  } catch {
    return void 0;
  }
}
function loadEnvCredential(region, env = process.env) {
  for (const name of region.patEnvNames) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return {
        region: region.id,
        appName: name,
        userID: "",
        name: "",
        email: "",
        token: value.trim(),
        refreshToken: "",
        refreshTokenExpiresAt: 0,
        expiresAt: 0,
        expired: false,
        userType: "",
        userTag: "",
        machineID: `dsh-connect-qoder-${region.id}`,
        source: "env-pat",
        plan: void 0,
        usage: void 0
      };
    }
  }
  return void 0;
}
function isCredentialUsable(cached, now = Date.now()) {
  if (cached === void 0 || cached === null) return false;
  if (cached.source === "env-pat") return Number(cached.expiresAt) > now;
  return cached.expired !== true;
}
function sweepStaleOscryptDirs(maxAgeMs = 5 * 60 * 1e3) {
  let names;
  try {
    names = (0, import_node_fs2.readdirSync)((0, import_node_os.tmpdir)());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let reclaimed = 0;
  for (const name of names) {
    if (!name.startsWith("qoder-oscrypt-")) continue;
    const dir = (0, import_node_path2.join)((0, import_node_os.tmpdir)(), name);
    let link;
    try {
      link = (0, import_node_fs2.lstatSync)(dir);
    } catch {
      continue;
    }
    if (link.isSymbolicLink()) {
      reportCleanupFailure(
        `refused to sweep ${dir}: it is a symbolic link, not a credential temp dir`
      );
      continue;
    }
    if (!link.isDirectory() || link.mtimeMs > cutoff) continue;
    let entries;
    try {
      entries = (0, import_node_fs2.readdirSync)(dir);
    } catch {
      continue;
    }
    if (!entries.includes(OSCRYPT_MARKER)) continue;
    if (entries.length !== 2 || !entries.includes("key.b64")) {
      reportCleanupFailure(
        `left ${dir} alone: it carries our marker but its contents are ${JSON.stringify(entries)}`
      );
      continue;
    }
    const keyFile = (0, import_node_path2.join)(dir, "key.b64");
    let unlockedBytes;
    try {
      unlockedBytes = Buffer.from((0, import_node_fs2.readFileSync)(keyFile, "utf8").trim(), "base64").length;
    } catch {
      unlockedBytes = 32;
    }
    if (unlockedBytes !== 32) {
      reportCleanupFailure(
        `left ${keyFile} alone: it decodes to ${unlockedBytes} bytes, not a 32-byte master key`
      );
      continue;
    }
    try {
      zeroOutFile(keyFile);
      zeroOutFile((0, import_node_path2.join)(dir, OSCRYPT_MARKER));
      (0, import_node_fs2.rmSync)(dir, { recursive: true, force: true });
      reclaimed += 1;
    } catch (error) {
      reportCleanupFailure(
        `could not reclaim the stale credential temp dir ${dir}: ${error?.message ?? error}`
      );
    }
  }
  return reclaimed;
}

// src/qoder/lib/credential-cache.js
var CredentialCache = class {
  /**
   * @param options.loadApp - `() => credential | undefined | Promise<...>`, reading the app's store.
   * @param options.loadEnv - `() => credential | undefined | Promise<...>`, the PAT fallback.
   * @param options.exchangePat - `(credential) => { token, refreshToken, expiresAt }`,
   *   called only for a PAT source; absent when PATs are not supported.
   */
  constructor({ loadApp, loadEnv, exchangePat: exchangePat2 }) {
    this.loadApp = loadApp;
    this.loadEnv = loadEnv;
    this.exchangePat = exchangePat2;
    this.cached = void 0;
    this.invalid = false;
    this.reads = 0;
    this.exchanges = 0;
  }
  /**
   * Resolve the credential to use for a request.
   *
   * A cached value is reused while it is still usable (see
   * `isCredentialUsable`); otherwise the app store is read, falling back to a
   * PAT, and a PAT is exchanged once for a job token.
   *
   * @returns the credential, or `undefined` when this machine has no sign-in.
   */
  async resolve() {
    if (this.invalid) {
      this.invalid = false;
      this.cached = void 0;
    }
    if (isCredentialUsable(this.cached)) return this.cached;
    this.reads += 1;
    const fromApp = await this.loadApp();
    const credential = fromApp ?? await this.loadEnv();
    if (credential === void 0) {
      this.cached = void 0;
      return void 0;
    }
    if (credential.source === "env-pat") {
      if (this.exchangePat === void 0) {
        this.cached = credential;
        return credential;
      }
      this.exchanges += 1;
      const exchanged = await this.exchangePat(credential);
      this.cached = {
        ...credential,
        token: exchanged.token,
        refreshToken: exchanged.refreshToken,
        expiresAt: exchanged.expiresAt
      };
      return this.cached;
    }
    this.cached = credential;
    return credential;
  }
  /**
   * Invalidate the cached credential after an upstream sign-in rejection.
   *
   * The next `resolve` re-reads the app's store, so a re-sign-in is picked up
   * without a restart. Called from the shim when the upstream answers with a
   * sign-in failure.
   */
  invalidate() {
    this.invalid = true;
  }
};

// src/qoder/lib/shim.js
var import_node_http = require("node:http");
var import_node_crypto4 = require("node:crypto");

// src/qoder/lib/upstream.js
var import_node_crypto3 = __toESM(require("node:crypto"), 1);
var import_node_child_process2 = require("node:child_process");
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");

// src/qoder/lib/errors.js
var QUEUE_MARKERS = ['"queueType"', '"retryAfterSeconds"', '"isQueued"', '"serviceAvailable"'];
function queueMarkerCount(text) {
  let count = 0;
  for (const marker of QUEUE_MARKERS) {
    if (text.includes(marker)) count += 1;
  }
  return count;
}
function queueSeconds(text) {
  let node = text;
  for (let depth = 0; depth < 4; depth++) {
    let parsed;
    try {
      parsed = JSON.parse(node);
    } catch {
      return 0;
    }
    if (parsed === null || typeof parsed !== "object") return 0;
    const seconds = Number(parsed.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
    if (typeof parsed.message !== "string") return 0;
    node = parsed.message;
  }
  return 0;
}
function classifyUpstreamError(chunk, code, detail) {
  const text = String(detail ?? "");
  const normalized = String(code ?? "");
  if (normalized === "10605") {
    return { kind: "rate-limit", retryAfterSeconds: queueSeconds(text) };
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || normalized === "105") {
    return { kind: "sign-in-expired" };
  }
  if (queueMarkerCount(text) >= 2) {
    return { kind: "rate-limit", retryAfterSeconds: queueSeconds(text) };
  }
  return { kind: "upstream" };
}
function isStaleCredentialError(error) {
  if (error?.signInExpired === true) return true;
  return /sign-in is no longer valid|sign-in-expired/i.test(String(error?.message ?? ""));
}

// src/qoder/lib/offpeak.js
function localSecondsOf(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(date);
    const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    const hour = read("hour") % 24;
    const minute = read("minute");
    const second = read("second");
    if (![hour, minute, second].every(Number.isFinite)) return void 0;
    return hour * 3600 + minute * 60 + second;
  } catch {
    return void 0;
  }
}
function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text).trim());
  if (match === null) return void 0;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return void 0;
  return hour * 3600 + minute * 60 + second;
}
function windowIsOpen(windowStart, windowEnd, timezone, now = /* @__PURE__ */ new Date()) {
  const start = parseClock(windowStart);
  const end = parseClock(windowEnd);
  if (start === void 0 || end === void 0 || start === end) return false;
  const seconds = localSecondsOf(now, timezone ?? "Asia/Shanghai");
  if (seconds === void 0) return false;
  return start < end ? seconds >= start && seconds < end : seconds >= start || seconds < end;
}

// src/qoder/lib/time.js
var SECONDS_BOUNDARY_MS = 1e12;
function toEpochMs(value) {
  if (value === null || value === void 0) return void 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return void 0;
    return value < SECONDS_BOUNDARY_MS ? Math.floor(value * 1e3) : Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}

// src/qoder/lib/claim.js
var CLAIM_BENEFIT_ACTION = "CLAIM_BENEFIT";
var CLAIMED_STATUS = "CLAIMED";
function benefitOf(campaign) {
  const benefit = campaign?.benefit;
  if (benefit === null || typeof benefit !== "object") return void 0;
  const amount = Number(benefit.amount);
  if (!Number.isFinite(amount) || amount <= 0) return void 0;
  const validityDays = Number(benefit.validity?.days);
  return {
    amount,
    kind: typeof benefit.kind === "string" ? benefit.kind : "CREDITS",
    ...Number.isFinite(validityDays) && validityDays > 0 ? { validDays: validityDays } : {}
  };
}
function windowOpenAt(campaign, nowMs) {
  const startAt = toEpochMs(campaign?.startAt ?? campaign?.beginAt);
  const endAt = toEpochMs(campaign?.endAt);
  if (startAt !== void 0 && nowMs < startAt) return false;
  if (endAt !== void 0 && nowMs > endAt) return false;
  return true;
}
function claimableCampaignOf(payload, nowMs = Date.now()) {
  const list = payload?.campaigns;
  if (!Array.isArray(list)) return void 0;
  for (const campaign of list) {
    if (campaign === null || typeof campaign !== "object") continue;
    if (campaign.actionType !== CLAIM_BENEFIT_ACTION) continue;
    if (!windowOpenAt(campaign, nowMs)) continue;
    return campaign;
  }
  return void 0;
}
function campaignIsClaimed(campaign) {
  return campaign?.claimStatus === CLAIMED_STATUS;
}
function checkinStateFrom(payload, nowMs = Date.now()) {
  const campaign = claimableCampaignOf(payload, nowMs);
  if (campaign === void 0) return { active: false, todayCheckedIn: false };
  const benefit = benefitOf(campaign);
  const endsAt = toEpochMs(campaign.endAt);
  return {
    active: true,
    todayCheckedIn: campaignIsClaimed(campaign),
    ...benefit !== void 0 ? {
      amount: benefit.amount,
      unit: benefit.kind === "CREDITS" ? "credits" : benefit.kind.toLowerCase(),
      ...benefit.validDays !== void 0 ? { validDays: benefit.validDays } : {}
    } : {},
    ...endsAt !== void 0 ? { endsAt } : {}
  };
}
function normalizeClaimResult(payload, campaign) {
  const body = payload?.data !== null && typeof payload?.data === "object" ? payload.data : payload;
  const status = typeof body?.status === "string" ? body.status : "";
  const replayed = body?.replayed === true;
  const granted = status === CLAIMED_STATUS || replayed || body?.success === true;
  const amountValue = Number(body?.benefit?.amount ?? (typeof campaign !== "undefined" ? benefitOf(campaign)?.amount : void 0));
  const expiresAt = toEpochMs(body?.expiresAt);
  return {
    claimed: granted,
    replayed,
    ...!replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {},
    ...expiresAt !== void 0 ? { expiresAt } : {}
  };
}

// src/qoder/lib/upstream.js
var QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
var COSY_VERSION = "1.1.38";
var CLIENT_TYPE = "5";
var MACHINE_TYPE = "5";
var DATA_POLICY = "disagree";
var QUEUE_WAIT_BUDGET_MS = 12e4;
var QUEUE_WAIT_MAX_SLEEP_MS = 3e4;
var QUEUE_WAIT_MIN_SLEEP_MS = 1e3;
var ATTEMPT_TIMEOUT_MS = 6e4;
var CATALOG_TIMEOUT_MS = 3e4;
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, Math.max(0, ms));
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
function readFailure(chunk, fallbackCode = "") {
  if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) return void 0;
  const hasCode = chunk.code != null || chunk.errorCode != null;
  const hasMessage = typeof chunk.message === "string" && chunk.message.length > 0 || typeof chunk.errorMessage === "string" && chunk.errorMessage.length > 0;
  if (!hasCode && !hasMessage) {
    if (fallbackCode === "") return void 0;
  }
  const { code, detail } = unwrapFailure(chunk);
  const effective = code !== "" ? code : fallbackCode;
  const kind = classifyUpstreamError(chunk, effective, detail);
  return { kind: kind.kind, retryAfterSeconds: kind.retryAfterSeconds ?? 0, code: effective, detail };
}
var LOGIN_VERSION = "v2";
var MACHINE_OS = process.platform === "win32" ? process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows" : process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
var CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
var STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var ENCODE_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < table.length; i++) table[i] = i;
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  }
  table["=".charCodeAt(0)] = "$".charCodeAt(0);
  return table;
})();
function encodeBody(plaintext) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const std = bytes.toString("base64");
  const n = std.length;
  const third = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - third; i < n; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)];
  for (let i = third; i < n - third; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < third; i++) out[dst++] = ENCODE_TABLE[std.charCodeAt(i)];
  return out;
}
function aesEncryptCBCBase64(plaintext, keyString) {
  const key = Buffer.from(keyString);
  const cipher = import_node_crypto3.default.createCipheriv("aes-128-cbc", key, key);
  return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}
function signaturePath(url) {
  let path = new URL(url).pathname;
  if (path.startsWith("/algo")) path = path.slice("/algo".length);
  return path;
}
function authHeaders(body, url, credential) {
  const aesKey = import_node_crypto3.default.randomUUID().replace(/-/g, "").slice(0, 16);
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? "",
      aid: "",
      email: credential.email ?? ""
    }),
    aesKey
  );
  const cosyKey = import_node_crypto3.default.publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: import_node_crypto3.default.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey)
  ).toString("base64");
  const timestamp = Math.floor(Date.now() / 1e3).toString();
  const payloadB64 = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: import_node_crypto3.default.randomUUID(),
      info: infoB64,
      cosyVersion: COSY_VERSION,
      ideVersion: ""
    })
  ).toString("base64");
  const path = signaturePath(url);
  const bodyBytes = body ?? Buffer.alloc(0);
  const sig = import_node_crypto3.default.createHash("md5").update(payloadB64).update("\n").update(cosyKey).update("\n").update(timestamp).update("\n").update(bodyBytes).update("\n").update(path).digest("hex");
  const machineID = credential.machineID;
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": credential.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": MACHINE_TYPE,
    "Cosy-Machineos": MACHINE_OS,
    "Cosy-Clienttype": CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": import_node_crypto3.default.createHash("md5").update(bodyBytes).digest("hex"),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": path,
    "Cosy-Data-Policy": DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": import_node_crypto3.default.randomUUID()
  };
}
function modelListUrl(region) {
  return `${region.baseUrl}algo/api/v2/model/list?Encode=1`;
}
function chatUrl(region) {
  return `${region.baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}
function exchangeUrl(region) {
  return `${region.openApiUrl}/api/v1/jobToken/exchange`;
}
function usageUrl(region) {
  return `${region.openApiUrl}/api/v2/quota/usage`;
}
function usagePresentationUrl(region) {
  return `${region.openApiUrl}/sash/api/v2/me/usage`;
}
function campaignsUrl(region) {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns`;
}
function openApiHeaders(credential, region) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${credential.token}`,
    "Cosy-ClientType": "10",
    "User-Agent": "Qoder",
    ...umidHeadersFor(region)
  };
}
var umidInfoByRegion = /* @__PURE__ */ new Map();
function umidHeadersFor(region) {
  const key = region?.id ?? "";
  let info = umidInfoByRegion.get(key);
  if (info === void 0) {
    info = readUmidInfo(region);
    umidInfoByRegion.set(key, info);
  }
  if (info === null) return {};
  return {
    "Cosy-MachineToken": info.machineToken,
    "Cosy-MachineCode": info.machineCode,
    "Cosy-MachineType": info.machineType
  };
}
function normalizeUmidBlock(answer) {
  if (typeof answer?.machineToken !== "string" || answer.machineToken.length === 0) return null;
  if (typeof answer?.machineType !== "string" || answer.machineType.length === 0) return null;
  if (typeof answer?.machineCode !== "string" || answer.machineCode.length === 0) return null;
  return { machineToken: answer.machineToken, machineType: answer.machineType, machineCode: answer.machineCode };
}
function readUmidInfo(region) {
  const probe = globalThis.__dshQoderUmidProbe;
  if (typeof probe === "function") {
    try {
      return normalizeUmidBlock(probe());
    } catch {
      return null;
    }
  }
  if (process.platform !== "win32") return null;
  const roots = umidRootsFor(region);
  for (const root of roots) {
    const binary = (0, import_node_path3.join)(root, "resources", "umid", "runtime-info.exe");
    if (!(0, import_node_fs3.existsSync)(binary)) continue;
    let output;
    try {
      output = (0, import_node_child_process2.execFileSync)(binary, [], { timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      continue;
    }
    try {
      const info = JSON.parse(output);
      if (typeof info?.machineToken !== "string" || info.machineToken.length === 0) continue;
      if (typeof info?.machineType !== "string" || typeof info?.machineCode !== "string") continue;
      return { machineToken: info.machineToken, machineType: info.machineType, machineCode: info.machineCode };
    } catch {
      continue;
    }
  }
  return null;
}
function umidRootsFor(region) {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === void 0) return [];
  const programs = (0, import_node_path3.join)(localAppData, "Programs");
  const roots = [
    (0, import_node_path3.join)(programs, "Qoder", ".qoder-versions", "0.4.3"),
    (0, import_node_path3.join)(programs, "Qoder")
  ];
  if (region?.id === "qoder-cn") roots.push((0, import_node_path3.join)(programs, "QoderCN"));
  return roots;
}
async function readJson(response, context) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const ct = response.headers.get("content-type") ?? "no content-type";
    throw new Error(`${context}: response is not valid JSON (${ct}) \u2014 ${text.slice(0, 300)}`);
  }
}
async function readCampaigns(region, credential, signal) {
  const response = await fetch(campaignsUrl(region), {
    method: "GET",
    headers: openApiHeaders(credential, region),
    redirect: "error",
    signal
  });
  if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status}`);
  return readJson(response, "Qoder campaigns");
}
function projectCampaignRows(payload) {
  const list = Array.isArray(payload?.campaigns) ? payload.campaigns : [];
  const rows = [];
  for (const campaign of list) {
    if (campaign === null || typeof campaign !== "object") continue;
    const placements = Array.isArray(campaign?.placements) ? campaign.placements : [];
    const usage = placements.find((entry) => entry?.type === "USAGE");
    if (usage === void 0) continue;
    const content = usage.content?.zh ?? usage.content?.["zh-CN"] ?? usage.content?.en ?? {};
    const endsAt = toEpochMs(campaign.endAt);
    rows.push({
      key: String(campaign.campaignKey ?? campaign.campaignId ?? ""),
      title: typeof content.title === "string" ? content.title : "",
      description: typeof content.description === "string" ? content.description : "",
      detailUrl: typeof content.detailUrl === "string" ? content.detailUrl : "",
      ...endsAt !== void 0 ? { endsAt } : {}
    });
  }
  return rows;
}
function claimCampaignUrl(region, campaignId) {
  return `${region.openApiUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`;
}
async function claimCampaign(region, credential, campaignId, signal) {
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new Error("Qoder check-in failed: no campaign id to claim");
  }
  const response = await fetch(claimCampaignUrl(region, campaignId), {
    method: "POST",
    headers: { ...openApiHeaders(credential, region), "Content-Type": "application/json" },
    body: "{}",
    redirect: "error",
    signal
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Qoder check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const ct = response.headers.get("content-type") ?? "no content-type";
    throw new Error(`Qoder check-in: response is not valid JSON (${ct}) \u2014 ${text.slice(0, 300)}`);
  }
}
function normalizeQuotaBucket(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const total = Number(value.total);
  const used = Number(value.used);
  if (!Number.isFinite(total) || total <= 0) return void 0;
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const remainingRaw = Number(value.remaining);
  const remaining = Number.isFinite(remainingRaw) ? Math.max(0, remainingRaw) : Math.max(0, total - safeUsed);
  const percentageRaw = Number(value.percentage);
  const percentage = Number.isFinite(percentageRaw) ? percentageRaw > 1 ? percentageRaw / 100 : percentageRaw : safeUsed / total;
  return {
    total,
    used: safeUsed,
    remaining,
    percentage: Math.min(1, Math.max(0, percentage)),
    unit: typeof value.unit === "string" && value.unit.length > 0 ? value.unit : "credits"
  };
}
function normalizeDedicatedPackage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const total = Number(value.total);
  if (id === "" || !Number.isFinite(total) || total <= 0) return void 0;
  const used = Number(value.used);
  const remainingRaw = Number(value.remaining);
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const remaining = Number.isFinite(remainingRaw) ? Math.max(0, remainingRaw) : Math.max(0, total - safeUsed);
  const percentageRaw = Number(value.percentage);
  const percentage = Number.isFinite(percentageRaw) ? percentageRaw > 1 ? percentageRaw / 100 : percentageRaw : safeUsed / total;
  const expiresAt = toEpochMs(value.expiresAt);
  return {
    id,
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    total,
    used: safeUsed,
    remaining,
    percentage: Math.min(1, Math.max(0, percentage)),
    unit: typeof value.unit === "string" && value.unit.length > 0 ? value.unit : "credits",
    ...expiresAt !== void 0 ? { expiresAt } : {},
    available: value.available !== false
  };
}
async function fetchUsage(region, credential, signal) {
  const headers = openApiHeaders(credential, region);
  const read = async (url) => {
    const response = await fetch(url, { method: "GET", headers, redirect: "error", signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readJson(response, "Qoder usage");
  };
  let payload;
  let source = "presentation";
  try {
    payload = await read(usagePresentationUrl(region));
  } catch (error) {
    if (signal?.aborted) throw error;
    source = "quota";
    payload = await read(usageUrl(region));
  }
  const usage = payload?.qoderUsage ?? payload?.data ?? payload;
  if (usage === null || typeof usage !== "object") return void 0;
  const userQuota = normalizeQuotaBucket(usage.user_quota ?? usage.userQuota);
  const addOnQuota = normalizeQuotaBucket(usage.add_on_quota ?? usage.addOnQuota);
  const rawPackages = usage.dedicated_resource_packages ?? usage.dedicatedResourcePackages;
  const dedicatedPackages = Array.isArray(rawPackages) ? rawPackages.map(normalizeDedicatedPackage).filter((entry) => entry !== void 0) : [];
  let campaigns = [];
  let checkin;
  try {
    const raw = await readCampaigns(region, credential, signal);
    campaigns = projectCampaignRows(raw);
    checkin = checkinStateFrom(raw);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const expiresAt = toEpochMs(usage.expires_at ?? usage.expiresAt);
  const isQuotaExceeded = usage.is_quota_exceeded ?? usage.isQuotaExceeded;
  if (userQuota === void 0 && addOnQuota === void 0 && dedicatedPackages.length === 0) return void 0;
  return {
    displayMode: typeof payload?.displayMode === "string" ? payload.displayMode : "qoder",
    userType: String(usage.user_type ?? usage.userType ?? ""),
    ...expiresAt !== void 0 ? { expiresAt } : {},
    upgradeUrl: String(usage.upgrade_url ?? usage.upgradeUrl ?? ""),
    ...userQuota !== void 0 ? { userQuota } : {},
    ...addOnQuota !== void 0 ? { addOnQuota } : {},
    dedicatedPackages,
    campaigns,
    ...checkin !== void 0 ? { checkin } : {},
    isQuotaExceeded: isQuotaExceeded === true,
    source
  };
}
async function fetchModels(region, credential, signal) {
  const url = modelListUrl(region);
  const headers = authHeaders(Buffer.alloc(0), url, credential);
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
    redirect: "error",
    // Never `undefined`: an unbounded fetch here can outlive the caller.
    signal: signal ?? AbortSignal.timeout(CATALOG_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Qoder model list failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const data = await readJson(response, "Qoder model list");
  const chat = data?.chat;
  if (chat === null || typeof chat !== "object") return [];
  const models = [];
  for (const entry of Object.values(chat)) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.key !== "string" || entry.key.length === 0) continue;
    if (entry.enable === false) continue;
    if (typeof entry.display_name !== "string" || entry.display_name.length === 0) continue;
    const config = entry.thinking_config;
    const efforts = config?.enabled?.efforts;
    const effortLevels = efforts !== null && typeof efforts === "object" ? Object.keys(efforts) : [];
    const supportsEffort = effortLevels.length > 0;
    const canDisableThinking = config?.disabled !== void 0;
    const windows = entry.context_config;
    const contextOptions = [];
    let defaultContextWindow = 0;
    if (windows !== null && typeof windows === "object") {
      for (const value of Object.values(windows)) {
        const tokens = Number(value?.token_count);
        if (!Number.isFinite(tokens) || tokens <= 0) continue;
        contextOptions.push(tokens);
        if (value?.is_default === true) defaultContextWindow = tokens;
      }
      contextOptions.sort((left, right) => left - right);
    }
    if (defaultContextWindow === 0) defaultContextWindow = Number(entry.max_input_tokens) || 0;
    models.push({
      key: entry.key,
      name: entry.display_name,
      isVL: entry.is_vl === true,
      isReasoning: entry.is_reasoning === true || config !== void 0,
      supportsEffort,
      alwaysThinking: supportsEffort && !canDisableThinking,
      effortLevels,
      defaultContextWindow,
      contextOptions,
      maxInputTokens: Number(entry.max_input_tokens) || 0,
      isDefault: entry.is_default === true,
      priceFactor: Number(entry.price_factor) || 0,
      isFree: entry.is_free === true,
      promotion: normalizePromotion(entry.promotion)
    });
  }
  return models;
}
function normalizePromotion(value, now = /* @__PURE__ */ new Date()) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const discountFactor = Number(value.discount_factor);
  const before = Number(value.before_promotion_price_factor);
  const windowStart = typeof value.window_start === "string" ? value.window_start : "";
  const windowEnd = typeof value.window_end === "string" ? value.window_end : "";
  const hasWindow = /^\d{2}:\d{2}$/.test(windowStart) && /^\d{2}:\d{2}$/.test(windowEnd);
  if (!Number.isFinite(discountFactor) && !Number.isFinite(before) && !hasWindow) return void 0;
  const timezone = typeof value.timezone === "string" && value.timezone.length > 0 ? value.timezone : "Asia/Shanghai";
  const pick = (field) => {
    const source = value[field];
    if (source === null || typeof source !== "object") return "";
    const text = source.zh ?? source["zh-CN"] ?? source.en;
    return typeof text === "string" ? text : "";
  };
  const active = value.active === true || value.active === false && hasWindow && !windowIsOpen(windowStart, windowEnd, timezone, now);
  return {
    active,
    windowStart: hasWindow ? windowStart : "",
    windowEnd: hasWindow ? windowEnd : "",
    timezone,
    ...Number.isFinite(discountFactor) ? { discountFactor } : {},
    ...Number.isFinite(before) ? { beforePromotionPriceFactor: before } : {},
    badge: pick("badge"),
    description: pick("description")
  };
}
async function exchangePat(region, pat, signal) {
  const response = await fetch(exchangeUrl(region), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ personal_access_token: pat }),
    redirect: "error",
    signal
  });
  if (!response.ok) {
    throw new Error(`Qoder PAT exchange failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const data = await readJson(response, "Qoder PAT exchange");
  const token = data?.token ?? data?.job_token ?? data?.jobToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Qoder PAT exchange returned no token");
  }
  return {
    token,
    refreshToken: typeof data?.refresh_token === "string" ? data.refresh_token : "",
    expiresAt: toEpochMs(data?.expires_at) ?? Date.now() + 36e5
  };
}
async function* streamChat(region, credential, request, signal) {
  const model = request.model;
  const recordID = import_node_crypto3.default.randomUUID();
  const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const parameters = {};
  if (Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0) {
    parameters.max_tokens = request.maxTokens;
  }
  if (request.enableThinking === true) {
    parameters.enable_thinking = true;
    if (typeof request.reasoningEffort === "string" && request.reasoningEffort.length > 0) {
      parameters.reasoning_effort = request.reasoningEffort;
    }
  } else if (request.alwaysThinking !== true) {
    parameters.enable_thinking = false;
  }
  const body = {
    request_id: import_node_crypto3.default.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: request.sessionId ?? `dsh-${import_node_crypto3.default.randomUUID()}`,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    // The upstream ignores a top-level `system` field; a leading role:system
    // message is what it actually honours.
    system: "",
    messages: request.messages,
    tools: request.tools ?? [],
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, is_reasoning: request.enableThinking === true },
        originalContent: lastText
      },
      features: [],
      text: lastText
    },
    model_config: { key: model, source: "system", is_reasoning: request.enableThinking === true },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: import_node_crypto3.default.randomUUID(),
      name: lastText.slice(0, 30),
      begin_at: Date.now()
    }
  };
  const url = chatUrl(region);
  const bodyBytes = encodeBody(Buffer.from(JSON.stringify(body)));
  async function* readFrames(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamDone = false;
    try {
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          if (payload === "[DONE]") {
            streamDone = true;
            break;
          }
          let envelope;
          try {
            envelope = JSON.parse(payload);
          } catch {
            continue;
          }
          let chunk = envelope;
          if (typeof envelope?.body === "string") {
            try {
              chunk = JSON.parse(envelope.body);
            } catch {
              continue;
            }
          } else if (envelope?.body !== void 0 && typeof envelope.body === "object") {
            chunk = envelope.body;
          }
          if (chunk?.choices !== void 0 || chunk?.usage !== void 0 && chunk.usage !== null) {
            yield chunk;
            continue;
          }
          const failure = readFailure(chunk);
          if (failure === void 0) continue;
          if (failure.kind === "rate-limit") {
            throw new QueueRejection(failure.retryAfterSeconds, failure.detail);
          }
          const message = failureMessage(failure, region);
          const error = new Error(message);
          if (failure.kind === "sign-in-expired") error.signInExpired = true;
          throw error;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
  }
  async function openAttempt() {
    let response;
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "Accept-Encoding": "identity",
      "X-Model-Key": model,
      "X-Model-Source": "system",
      ...authHeaders(bodyBytes, url, credential)
    };
    const deadline = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    const attemptSignal = signal === void 0 ? deadline : AbortSignal.any([signal, deadline]);
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: bodyBytes,
        redirect: "error",
        signal: attemptSignal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadline.aborted) {
        throw new QueueRejection(
          0,
          `no response headers within ${Math.round(ATTEMPT_TIMEOUT_MS / 1e3)}s`
        );
      }
      const cause = error?.cause;
      const code = cause?.code ?? error?.code ?? "";
      if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ENOTFOUND" || code === "UND_ERR_SOCKET" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || error?.message?.includes?.("fetch failed")) {
        throw new QueueRejection(0, `network: ${cause?.message ?? error?.message ?? error}`);
      }
      throw error;
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      if (response.status === 429 || response.status >= 500) {
        let retryAfter = 0;
        const header = response.headers.get("retry-after");
        if (header !== null) {
          const seconds = Number(header);
          if (Number.isFinite(seconds) && seconds > 0) {
            retryAfter = seconds;
          } else {
            const date = Date.parse(header);
            if (Number.isFinite(date)) {
              retryAfter = Math.max(0, Math.ceil((date - Date.now()) / 1e3));
            }
          }
        }
        throw new QueueRejection(retryAfter, `HTTP ${response.status} \u2014 ${text}`);
      }
      const failure = readFailure({ code: String(response.status), message: text }, String(response.status));
      if (failure === void 0) {
        throw new Error(`Qoder chat failed: HTTP ${response.status} ${response.statusText} \u2014 ${text}`);
      }
      if (failure.kind === "rate-limit") throw new QueueRejection(failure.retryAfterSeconds, failure.detail);
      const message = failureMessage(failure, region, response.status, response.statusText);
      const error = new Error(message);
      if (failure.kind === "sign-in-expired") error.signInExpired = true;
      throw error;
    }
    if (response.body === null) throw new Error("Qoder chat returned no body");
    return response;
  }
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    let stream;
    let first;
    const attemptStartedAt = Date.now();
    try {
      stream = readFrames(await openAttempt());
      first = await stream.next();
    } catch (error) {
      waitedMs += Date.now() - attemptStartedAt;
      const queueWaitMs = queueWaitFor(error, waitedMs, attempt);
      if (queueWaitMs === void 0) throw error;
      if (signal?.aborted) throw error;
      await sleep(queueWaitMs, signal);
      waitedMs += queueWaitMs;
      continue;
    }
    waitedMs += Date.now() - attemptStartedAt;
    if (first.done === true) {
      throw new Error(`${region.displayName} returned an empty response`);
    }
    try {
      yield first.value;
      for (; ; ) {
        const step = await stream.next();
        if (step.done === true) break;
        yield step.value;
      }
    } finally {
      await stream.return(void 0).catch(() => {
      });
    }
    return;
  }
}
var QueueRejection = class extends Error {
  constructor(retryAfterSeconds, detail) {
    super(
      `Qoder is busy \u2014 the request was queued${retryAfterSeconds > 0 ? ` (retry in ~${retryAfterSeconds}s)` : ""}`
    );
    this.name = "QueueRejection";
    this.retryable = true;
    this.retryAfterSeconds = retryAfterSeconds;
    this.upstreamDetail = detail;
  }
};
function queueWaitFor(error, waitedMs, attempt) {
  if (error?.retryable !== true) return void 0;
  const remaining = QUEUE_WAIT_BUDGET_MS - waitedMs;
  if (remaining <= 0) return void 0;
  const hinted = Number(error.retryAfterSeconds) > 0 ? Number(error.retryAfterSeconds) * 1e3 : QUEUE_WAIT_MIN_SLEEP_MS;
  const GRACE_ATTEMPTS = 3;
  const escalated = attempt > GRACE_ATTEMPTS ? QUEUE_WAIT_MIN_SLEEP_MS * 2 ** Math.min(attempt - GRACE_ATTEMPTS, 8) : 0;
  const target = Math.max(hinted, escalated) * (0.75 + Math.random() * 0.5);
  const clamped = Math.max(QUEUE_WAIT_MIN_SLEEP_MS, Math.min(target, QUEUE_WAIT_MAX_SLEEP_MS));
  return Math.min(clamped, remaining);
}
function failureMessage(failure, region, status, statusText) {
  if (failure.kind === "sign-in-expired") {
    return `${region.displayName} sign-in is no longer valid \u2014 open the ${region.displayName} app to sign in again, then restart DSH${status !== void 0 ? ` (HTTP ${status}: ${failure.detail})` : ` (upstream ${failure.code || "error"}: ${failure.detail})`}`;
  }
  if (status === 401 || status === 403) {
    return `${region.displayName} was refused by Qoder \u2014 check that this account can use this model (HTTP ${status}: ${failure.detail})`;
  }
  if (status !== void 0) {
    return `Qoder chat failed: HTTP ${status} ${statusText ?? ""} \u2014 ${failure.detail}`;
  }
  return `Qoder upstream error${failure.code !== "" ? ` ${failure.code}` : ""}${failure.detail.length > 0 ? `: ${failure.detail}` : ""}`;
}
function tryJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return void 0;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unwrapFailure(chunk) {
  let code = "";
  let detail = "";
  let node = chunk;
  let descended = false;
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break;
    const levelCode = node.errorCode ?? node.code;
    if (typeof levelCode === "string" && levelCode.length > 0) code = levelCode;
    else if (typeof levelCode === "number" && Number.isFinite(levelCode)) code = String(levelCode);
    const message = node.message ?? node.errorMessage;
    if (typeof message === "string" && message.length > 0) detail = message;
    const nested = isPlainObject(node.details) ? node.details : isPlainObject(node.error) ? node.error : void 0;
    const next = nested ?? (typeof message === "string" ? tryJsonObject(message) : void 0);
    if (next === void 0) break;
    node = next;
    descended = true;
  }
  if (descended && isPlainObject(node) && typeof node.message !== "string") {
    detail = JSON.stringify(node);
  }
  return { code, detail };
}
function toQoderMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      out.push({ role: "system", content: textOf(message.content) });
      continue;
    }
    if (message.role === "user") {
      const parts = [];
      let hasImage = false;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "text") parts.push({ type: "text", text: block.text ?? "" });
          else if (block?.type === "image_url" || block?.type === "image") {
            const url = block.image_url?.url ?? (typeof block.data === "string" ? `data:${block.mimeType ?? "image/png"};base64,${block.data}` : void 0);
            if (url !== void 0) {
              hasImage = true;
              parts.push({ type: "image_url", image_url: { url } });
            }
          }
        }
      }
      out.push({ role: "user", content: hasImage ? parts : textOf(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      const toolCalls = [];
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call == null || typeof call !== "object") continue;
          const id = call.id;
          if (typeof id !== "string" || id.length === 0) {
            throw new Error("toQoderMessages: assistant tool_call is missing an id; the tool loop cannot match the result back to it");
          }
          const name = call.function?.name ?? call.name;
          if (typeof name !== "string" || name.length === 0) {
            throw new Error(`toQoderMessages: assistant tool_call "${id}" has no function name; the gateway cannot dispatch it`);
          }
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments: typeof call.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call.function?.arguments ?? call.arguments ?? {})
            }
          });
        }
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "text") text += block.text ?? "";
          else if (block?.type === "toolCall") {
            const id = block.id;
            if (typeof id !== "string" || id.length === 0) {
              throw new Error("toQoderMessages: assistant toolCall block is missing an id; the tool loop cannot match the result back to it");
            }
            if (typeof block.name !== "string" || block.name.length === 0) {
              throw new Error(`toQoderMessages: toolCall "${id}" has no function name; the gateway cannot dispatch it`);
            }
            toolCalls.push({
              id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) }
            });
          }
        }
      } else {
        text = textOf(message.content);
      }
      const entry = { role: "assistant", content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool") {
      const toolCallId = message.toolCallId ?? message.tool_call_id;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new Error("toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn");
      }
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: textOf(message.content)
      });
    }
  }
  return out;
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type === "text") text += block.text ?? "";
  }
  return text;
}
function toQoderTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool, index) => {
    if (tool?.function != null && typeof tool.function === "object") {
      const name2 = tool.function.name;
      if (typeof name2 !== "string" || name2.length === 0) {
        throw new Error(`toQoderTools: tool at index ${index} has no function name; the gateway cannot register it`);
      }
      return {
        type: "function",
        function: {
          name: name2,
          description: tool.function.description ?? "",
          parameters: tool.function.parameters ?? { type: "object", properties: {} }
        }
      };
    }
    const name = tool?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`toQoderTools: tool at index ${index} has no name; the gateway cannot register it`);
    }
    return {
      type: "function",
      function: {
        name,
        description: tool?.description ?? "",
        parameters: tool?.parameters ?? { type: "object", properties: {} }
      }
    };
  });
}

// src/qoder/lib/catalog-entry.js
function modelIdFor(entry) {
  return (entry.display_name || "QoderModel").replace(/\s+/g, "");
}
function normalizeEntry(entry) {
  return {
    id: modelIdFor({ display_name: entry.name }),
    key: entry.key,
    name: entry.name,
    isVL: entry.isVL === true,
    isReasoning: entry.isReasoning === true,
    supportsEffort: entry.supportsEffort === true,
    alwaysThinking: entry.alwaysThinking === true,
    effortLevels: Array.isArray(entry.effortLevels) ? entry.effortLevels : [],
    maxInputTokens: entry.maxInputTokens ?? 0,
    // `toPiModel` sizes each model from these two, so dropping them here (which
    // is what happened before) made `useMaximumContextWindow` do nothing at all:
    // with no `contextOptions` the "widest offered window" is 0, the switch has
    // nothing to prefer, and every model falls back to `max_input_tokens` — a
    // smaller per-request floor, not the capacity the catalog advertises. They
    // are carried through verbatim so the setting and the picker agree.
    defaultContextWindow: entry.defaultContextWindow ?? 0,
    contextOptions: Array.isArray(entry.contextOptions) ? entry.contextOptions : [],
    // The credit multiplier Qoder charges for this model. It is display-only,
    // but the picker shows it beside the name so the cost of a choice is visible
    // before the request is sent. `toPiModel` is what formats it.
    priceFactor: Number(entry.priceFactor) || 0,
    // Free models skip the credit multiplier entirely; the picker reads
    // `isFree` to display 免费 instead of `x0.00`.
    isFree: entry.isFree === true,
    // Whether Qoder starts the app on this model by default
    // (`entry.is_default` in the raw catalog; the app's initial selection).
    isDefault: entry.isDefault === true,
    // The time-of-day discount block (`fetchModels` produced it as
    // `promotion` — the off-peak window, its discounted and pre-promotion
    // multipliers, and the copy that describes it). Dropped once: with the
    // field missing from the catalog entry, `toPiModel` and the settings
    // card both saw `promotion === undefined` and the whole off-peak
    // machinery — the `错峰` name suffix, the window countdown, the
    // `before × discount` rate — was dead code that could never fire.
    //
    // Carried through verbatim, `active` and `timezone` included: the card
    // gates its ticking clock on `promotion.active` and resolves the window
    // against `timezone`, so losing either silently freezes the rate at whatever
    // it was when the card mounted.
    promotion: entry.promotion
  };
}
function filterByEnabled(models, enabled) {
  const list = Array.isArray(enabled) ? enabled.filter((id) => typeof id === "string" && id.length > 0) : [];
  if (list.length === 0) return models;
  const allowed = new Set(list.map(normalizeModelId));
  return models.filter((entry) => allowed.has(normalizeModelId(entry.id)));
}
function normalizeModelId(id) {
  return String(id).toLowerCase().replace(/[\s\-_.]/g, "");
}

// src/qoder/lib/http-utils.js
function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}
function writeError(res, status, code, message, extraHeaders = void 0) {
  const payload = JSON.stringify({ error: { message, type: code, code } });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders ?? {}
  });
  res.end(payload);
}

// src/qoder/lib/shim.js
function hostIsLoopback(host) {
  if (typeof host !== "string") return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}
function originIsLoopback(origin) {
  if (origin === void 0) return true;
  if (typeof origin !== "string") return false;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}
var RETRY_AFTER_MAX_SECONDS = 20;
function retryAfterHeader(error) {
  const seconds = Number(error?.retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return void 0;
  const clamped = Math.min(Math.max(Math.ceil(seconds), 1), RETRY_AFTER_MAX_SECONDS);
  return { "Retry-After": String(clamped) };
}
var MAX_BODY_BYTES = 20 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("request body exceeds the 20 MiB limit"), { name: "BodyTooLargeError" }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
function createQoderShim(options) {
  const {
    resolveCredential,
    resolveModels,
    resolveUpstreamKey,
    resolveAlwaysThinking,
    resolveEnabledIds,
    invalidateCredential,
    region,
    logger,
    // Called before the two directory-reading routes. Absent on the Pi port,
    // which refreshes from `auth.apiKey.resolve()` instead.
    refreshCatalog,
    // Endpoint stability. Both are optional so the Pi port keeps its original
    // per-process behaviour; Cyrene persists them so a model profile survives a
    // restart. `preferredPort` is only a preference — a busy port falls back to
    // a random one rather than failing activation.
    secret: injectedSecret,
    preferredPort,
    // The upstream call, injectable so a test can force a queue rejection (or
    // any other failure) without reaching the real gateway. Everything else the
    // shim does is observable over HTTP, but no test can ask Qoder to be busy
    // on demand — and a 503 that carried no `Retry-After` was exactly the kind
    // of regression that would ship unnoticed.
    runChat = streamChat
  } = options;
  const SHARED_SECRET = typeof injectedSecret === "string" && injectedSecret.length > 0 ? injectedSecret : (0, import_node_crypto4.randomBytes)(32).toString("base64url");
  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const presented = Buffer.from(match[1]);
    const expected = Buffer.from(SHARED_SECRET);
    if (presented.length !== expected.length) return false;
    return (0, import_node_crypto4.timingSafeEqual)(presented, expected);
  }
  const server = (0, import_node_http.createServer)((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) writeError(res, 500, "internal", String(error));
      else res.end();
    });
  });
  const attemptBind = (port) => new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });
  const ready = (async () => {
    const preferred = typeof preferredPort === "number" && Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 0;
    if (preferred === 0) {
      await attemptBind(0);
      return;
    }
    try {
      await attemptBind(preferred);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      logger?.warn?.(`dsh-connect-qoder: \u7AEF\u53E3 ${preferred} \u5DF2\u88AB\u5360\u7528\uFF0C\u6539\u7528\u968F\u673A\u7AEF\u53E3\uFF08\u6A21\u578B\u6863\u6848\u91CC\u7684 Base URL \u9700\u8981\u66F4\u65B0\uFF09`);
      await attemptBind(0);
    }
  })();
  server.unref();
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("qoder shim has no listening address");
    return `http://127.0.0.1:${address.port}`;
  };
  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
      return;
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
      return;
    }
    if (!bearerOk(req)) {
      writeError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
      return;
    }
    const url = req.url ?? "/";
    const catalogRoute = req.method === "GET" && (url === "/v1/models" || url === "/v1/models/") || req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/");
    if (catalogRoute && typeof refreshCatalog === "function") {
      const haveModels = resolveModels().length > 0;
      const refreshed = (async () => {
        try {
          return await refreshCatalog();
        } catch (error) {
          logger?.warn?.(`dsh-connect-qoder: ${region.displayName} \u8BF7\u6C42\u524D\u76EE\u5F55\u5237\u65B0\u5931\u8D25\uFF0C\u4F7F\u7528\u7F13\u5B58\u76EE\u5F55`, error);
          return void 0;
        }
      })();
      if (!haveModels) await refreshed;
    }
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
      const enabled = typeof resolveEnabledIds === "function" ? resolveEnabledIds() : void 0;
      const data = filterByEnabled(resolveModels(), enabled).map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: region.id
      }));
      sendJson(res, 200, { object: "list", data });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await chatCompletions(req, res);
      return;
    }
    writeError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  }
  async function chatCompletions(req, res) {
    let credential;
    try {
      credential = await resolveCredential();
    } catch (error) {
      writeError(res, 401, "not_signed_in", String(error));
      return;
    }
    if (!credential) {
      writeError(res, 401, "not_signed_in", `${region.displayName} is not signed in on this machine`);
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch (error) {
      if (error?.name === "BodyTooLargeError") {
        writeError(res, 413, "payload_too_large", "request body exceeds the 20 MiB limit");
        return;
      }
      writeError(res, 400, "invalid_request", `body is not JSON: ${String(error)}`);
      return;
    }
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const enableThinking = resolveThinking(body);
    const displayModel = body.model;
    const catalogEntry = resolveModels().find((model) => model.id === displayModel);
    const alwaysThinking = resolveAlwaysThinking?.(displayModel) ?? catalogEntry?.alwaysThinking === true;
    const request = {
      // DSH sends the user-facing model id; the wire needs Qoder's own key.
      model: resolveUpstreamKey(body.model) ?? body.model,
      messages: toQoderMessages(body.messages ?? []),
      tools: toQoderTools(body.tools),
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : void 0,
      enableThinking,
      alwaysThinking,
      reasoningEffort: enableThinking ? body.reasoning_effort : void 0,
      sessionId: typeof body.user === "string" ? body.user : void 0
    };
    const wantStream = body.stream !== false;
    let iterator;
    try {
      iterator = runChat(region, credential, request, controller.signal);
      var first = await iterator.next();
    } catch (error) {
      logger?.warn?.(`dsh-connect-qoder: ${region.displayName} upstream failed`, error);
      const signInStale = isStaleCredentialError(error);
      if (signInStale) {
        invalidateCredential?.();
      }
      if (error?.retryable === true) {
        writeError(res, 503, "rate_limit", String(error?.message ?? error), retryAfterHeader(error));
        return;
      }
      writeError(res, 502, "upstream_error", String(error?.message ?? error));
      return;
    }
    if (!wantStream) {
      const content = [];
      const toolCalls = /* @__PURE__ */ new Map();
      let finish = "stop";
      let usage;
      for (let step = first; !step.done; step = await iterator.next()) {
        if (step.value?.usage !== void 0 && step.value.usage !== null) usage = step.value.usage;
        absorb(step.value, content, toolCalls, (f) => {
          finish = f;
        });
      }
      const message = { role: "assistant", content: content.join("") };
      if (toolCalls.size > 0) message.tool_calls = [...toolCalls.values()];
      sendJson(res, 200, {
        id: `chatcmpl-${(0, import_node_crypto4.randomBytes)(8).toString("hex")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1e3),
        model: displayModel,
        choices: [{ index: 0, message, finish_reason: finish }],
        // Present only when upstream reported it; an absent field is better than
        // a fabricated zero, which would read as "this turn cost nothing".
        ...usage !== void 0 ? { usage } : {}
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const id = `chatcmpl-${(0, import_node_crypto4.randomBytes)(8).toString("hex")}`;
    const created = Math.floor(Date.now() / 1e3);
    let sentRole = false;
    try {
      for (let step = first; !step.done; step = await iterator.next()) {
        const chunk = step.value;
        if (chunk?.usage !== void 0 && chunk.usage !== null) {
          writeSse(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: displayModel,
            choices: [],
            usage: chunk.usage
          });
        }
        const choice = chunk?.choices?.[0];
        if (choice === void 0) continue;
        const delta = choice.delta ?? choice.message ?? {};
        const out = { role: "assistant" };
        if (typeof delta.content === "string" && delta.content.length > 0) out.content = delta.content;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) out.reasoning_content = reasoning;
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls;
        const finish = choice.finish_reason;
        if (!sentRole) {
          sentRole = true;
        } else if (Object.keys(out).length === 1 && finish === void 0) {
          continue;
        }
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: displayModel,
          choices: [{ index: 0, delta: out, finish_reason: finish ?? null }]
        });
      }
    } catch (error) {
      logger?.warn?.(`dsh-connect-qoder: ${region.displayName} stream broke`, error);
      const retryable = error?.retryable === true;
      const kind = retryable ? "rate_limit" : "upstream_error";
      const message = String(error?.message ?? error);
      if (isStaleCredentialError(error)) {
        invalidateCredential?.();
      }
      if (retryable) {
        logger?.warn?.(
          `dsh-connect-qoder: ${region.displayName} queued by Qoder; reporting 503 so DSH retries: ${message}`
        );
      }
      res.write(`data: ${JSON.stringify({ error: { message, type: kind, code: kind } })}

`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
  function resolveThinking(body) {
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0) {
      return body.reasoning_effort !== "off" && body.reasoning_effort !== "none";
    }
    if (body.thinking !== void 0) return body.thinking !== false && body.thinking !== "off";
    return false;
  }
  let closed = false;
  let closedPromise;
  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    // Idempotent close: a second call (e.g. effect cleanup running twice
    // under React strict mode, or dispose + unmount racing) returns the
    // same settled promise instead of calling server.close() again, which
    // would emit an 'error' event and reject the caller.
    close: () => {
      if (closed) return closedPromise;
      closed = true;
      closedPromise = new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err && err.code !== "ERR_SERVER_NOT_RUNNING") reject(err);
          else resolve();
        });
      });
      return closedPromise;
    }
  };
}
function absorb(chunk, content, toolCalls, setFinish) {
  const choice = chunk?.choices?.[0];
  if (choice === void 0) return;
  const delta = choice.delta ?? choice.message ?? {};
  if (typeof delta.content === "string") content.push(delta.content);
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      const index = call.index ?? 0;
      const current = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name = call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
  }
  if (choice.finish_reason) setFinish(choice.finish_reason);
}
function writeSse(res, value) {
  res.write(`data: ${JSON.stringify(value)}

`);
}

// src/qoder/lib/catalog-store.js
var import_node_fs4 = require("node:fs");
var import_node_path4 = require("node:path");
var CATALOG_TTL_MS = 30 * 60 * 1e3;
var CATALOG_FORMAT_VERSION = 1;
var CatalogStore = class {
  /**
   * @param options.path - where the catalog file lives.
   * @param options.ttlMs - how long a fetch stays fresh; injectable for tests.
   * @param options.logger - optional, for a failed save.
   */
  constructor({ path, ttlMs = CATALOG_TTL_MS, logger } = {}) {
    this.path = path;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.entries = [];
    this.fetchedAt = 0;
    this.lastSaveError = void 0;
    this.load();
  }
  load() {
    const tmp = `${this.path}.tmp`;
    try {
      if ((0, import_node_fs4.existsSync)(tmp)) (0, import_node_fs4.unlinkSync)(tmp);
    } catch {
    }
    if (!(0, import_node_fs4.existsSync)(this.path)) return;
    try {
      const parsed = JSON.parse((0, import_node_fs4.readFileSync)(this.path, "utf8"));
      if (parsed?.version !== CATALOG_FORMAT_VERSION) return;
      if (!Array.isArray(parsed.entries)) return;
      this.entries = parsed.entries;
      this.fetchedAt = Number(parsed.fetchedAt) || 0;
    } catch {
    }
  }
  save() {
    this.lastSaveError = void 0;
    const tmp = `${this.path}.tmp`;
    try {
      (0, import_node_fs4.mkdirSync)((0, import_node_path4.dirname)(this.path), { recursive: true });
      (0, import_node_fs4.writeFileSync)(tmp, JSON.stringify({ version: CATALOG_FORMAT_VERSION, fetchedAt: this.fetchedAt, entries: this.entries }, null, 2), "utf8");
      (0, import_node_fs4.renameSync)(tmp, this.path);
    } catch (error) {
      this.lastSaveError = error;
      try {
        if ((0, import_node_fs4.existsSync)(tmp)) (0, import_node_fs4.unlinkSync)(tmp);
      } catch {
      }
      this.logger?.warn?.(`dsh-connect-qoder: could not save catalog ${this.path}`, error);
    }
  }
  current() {
    return this.entries;
  }
  fresh(now = Date.now()) {
    return now - this.fetchedAt < this.ttlMs;
  }
  replace(entries, now = Date.now()) {
    this.entries = entries;
    this.fetchedAt = now;
    this.save();
  }
};

// src/qoder/runtime.js
var CATALOG_RETRY_AFTER_FAILURE_MS = 60 * 1e3;
var RegionRuntime = class {
  constructor(region, logger, cacheRoot, endpoints, portIndex = 0) {
    this.region = region;
    this.logger = logger;
    this.cacheRoot = cacheRoot;
    this.endpoints = endpoints;
    this.portIndex = portIndex;
    this.credentials = new CredentialCache({
      loadApp: () => loadCredential(region, process.env.APPDATA ?? ""),
      loadEnv: () => loadEnvCredential(region),
      exchangePat: async (credential) => exchangePat(region, credential.token)
    });
    this.catalog = new CatalogStore({
      path: (0, import_node_path5.join)(cacheRoot, `.qoder-catalog.${region.id}.json`),
      logger
    });
    this.shim = void 0;
    this.disposed = false;
    this.catalogPending = void 0;
    this.catalogFailedAt = 0;
  }
  /** Start the loopback shim; called only when a session or a request needs it. */
  startShim() {
    if (this.shim !== void 0) return this.shim;
    this.shim = createQoderShim({
      region: this.region,
      resolveCredential: () => this.resolveCredential(),
      resolveModels: () => this.catalog.current(),
      resolveUpstreamKey: (id) => this.upstreamKey(id),
      resolveAlwaysThinking: (id) => this.entryFor(id)?.alwaysThinking === true,
      resolveEnabledIds: () => [],
      invalidateCredential: () => this.credentials.invalidate(),
      logger: this.logger,
      // Lets a request refresh the directory, mirroring what the Pi port does
      // from `auth.apiKey.resolve()`. TTL-gated inside `refreshCatalog`.
      refreshCatalog: () => this.refreshCatalog(),
      ...this.endpoints === void 0 ? {} : {
        secret: this.endpoints.tokenFor(this.region.id),
        preferredPort: this.endpoints.preferredPortFor(this.region.id, this.portIndex)
      }
    });
    return this.shim;
  }
  /** Start the shim (if needed) and wait until it is listening. */
  async ensureShim() {
    const shim = this.startShim();
    await shim.ready;
    if (this.endpoints !== void 0) {
      const port = Number(new URL(shim.baseUrl()).port);
      if (Number.isInteger(port) && port > 0) this.endpoints.recordPort(this.region.id, port);
    }
    return shim;
  }
  /**
   * The loopback base URL when the shim is running, or a placeholder.
   *
   * Pi's extension contract forbids starting sockets in the factory, so a
   * model list may be built before the shim exists. The placeholder is only
   * ever a display value: the authoritative base URL travels with
   * `auth.apiKey.resolve`, and `ModelRuntime.prepareRequest` overwrites the
   * model's `baseUrl` from it before any request is sent.
   */
  baseUrlOrPlaceholder() {
    if (this.shim === void 0) return "http://127.0.0.1:0/v1";
    try {
      return `${this.shim.baseUrl()}/v1`;
    } catch {
      return "http://127.0.0.1:0/v1";
    }
  }
  async resolveCredential() {
    return this.credentials.resolve();
  }
  upstreamKey(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId)?.key;
  }
  entryFor(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId);
  }
  /**
   * Fetch a fresh catalog and keep the last good one on failure.
   *
   * Single-flight. An empty catalog or an expired TTL used to make every
   * concurrent caller run its own `fetchModels`, and the two results raced:
   * the fetch that *started* first could *finish* last and overwrite the newer
   * directory, which was then re-cached for another 30 minutes. Reusing the
   * in-flight promise removes the race by construction — there is only ever
   * one result to land.
   *
   * The signal is honoured only by the flight that creates the slot. A caller
   * that joins mid-flight is waiting on someone else's fetch and has no claim
   * on its cancellation; letting a joiner abort it would turn one caller's
   * timeout into everyone's. In practice the creator is either the warm-up
   * (which passes `ctx.signal` + `WARM_TIMEOUT_MS`) or the request path (which
   * passes nothing, and `fetchModels` then applies its own 30s ceiling).
   *
   * `force` skips the TTL check so the panel's explicit "refresh" button can
   * pick up new models inside the 30-minute window, and the 60-second failure
   * backoff. An in-flight fetch is still shared: it is already asking upstream,
   * so a second one would only duplicate the call.
   */
  async refreshCatalog(signal, { force = false } = {}) {
    if (this.catalogPending !== void 0) return this.catalogPending;
    if (!force && this.catalog.fresh()) return;
    if (!force && Date.now() - this.catalogFailedAt < CATALOG_RETRY_AFTER_FAILURE_MS) return;
    const flight = this.fetchCatalog(signal).finally(() => {
      if (this.catalogPending === flight) this.catalogPending = void 0;
    });
    this.catalogPending = flight;
    return flight;
  }
  /** One catalog fetch. Split out so `refreshCatalog` owns only the slot. */
  async fetchCatalog(signal) {
    this.credentials.invalidate();
    const credential = await this.resolveCredential();
    if (credential === void 0) return;
    try {
      const raw = await fetchModels(this.region, credential, signal);
      const entries = raw.map(normalizeEntry);
      if (entries.length > 0) {
        this.catalog.replace(entries);
        this.catalogFailedAt = 0;
        return;
      }
      this.catalogFailedAt = Date.now();
      this.logger?.warn?.(
        `dsh-connect-qoder[pi]: ${this.region.displayName} catalog came back empty; serving cached catalog`
      );
    } catch (error) {
      this.catalogFailedAt = Date.now();
      this.logger?.warn?.(
        `dsh-connect-qoder[pi]: ${this.region.displayName} catalog refresh failed; serving cached catalog`,
        error
      );
    }
  }
  async close() {
    this.disposed = true;
    if (this.shim !== void 0) await this.shim.close();
  }
};
async function createQoderRuntimes({ cacheRoot, logger, endpoints }) {
  setCredentialDiagnosticSink((message) => logger.warn(message));
  try {
    sweepStaleOscryptDirs();
  } catch {
  }
  return REGIONS.map((region, index) => new RegionRuntime(region, logger, cacheRoot, endpoints, index));
}

// src/trae/lib/trae-core.js
var import_promises = require("node:fs/promises");
var import_node_crypto5 = require("node:crypto");
var import_node_path6 = require("node:path");
var import_node_os2 = require("node:os");
var import_node_http2 = require("node:http");
var import_node_stream = require("node:stream");
var import_node_child_process3 = require("node:child_process");
var import_node_util2 = require("node:util");
var FALLBACK_TRAE_MODELS = [
  {
    id: "DeepSeek-V4-Flash-Official",
    name: "DeepSeek-V4-Flash",
    contextWindow: 2e5
  },
  {
    id: "DeepSeek-V4-Pro-Official",
    name: "DeepSeek-V4-Pro",
    contextWindow: 2e5
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextWindow: 2e5
  },
  {
    id: "kimi-k2.6",
    name: "Kimi-K2.6",
    contextWindow: 2e5
  }
];
var FALLBACK_TRAE_MODELS_AI = [
  {
    id: "gemini-3.1-pro",
    name: "Gemini-3.1-Pro-Preview",
    contextWindow: 2e5
  },
  {
    id: "gemini-3-flash-solo",
    name: "Gemini-3-Flash-Preview",
    contextWindow: 2e5
  },
  {
    id: "minimax-m3",
    name: "MiniMax-M3",
    contextWindow: 2e5
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax-M2.7",
    contextWindow: 2e5
  },
  {
    id: "kimi-k2.5",
    name: "Kimi-K2.5",
    contextWindow: 2e5
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272e3
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    contextWindow: 272e3
  }
];
function fallbackModelsFor(region) {
  return region === "ai" ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS;
}
function displayKey(name) {
  return name.trim().toLowerCase();
}
function mergeTraeModelSources(remote, wire) {
  const wireByName = /* @__PURE__ */ new Map();
  const wireById = /* @__PURE__ */ new Map();
  for (const model of wire) {
    wireByName.set(displayKey(model.name), model);
    wireById.set(displayKey(model.id), model);
  }
  const result = [];
  for (const model of remote) {
    const wireModel = wireById.get(displayKey(model.id)) ?? wireByName.get(displayKey(model.name));
    if (wireModel === void 0) continue;
    const creditMultiplier = wireModel.creditMultiplier ?? model.creditMultiplier;
    result.push({
      id: model.id,
      name: model.name,
      ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
      ...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
      ...creditMultiplier === void 0 ? {} : { creditMultiplier },
      input: ["text"],
      reasoningSupported: model.reasoningSupported,
      ...model.reasoning === void 0 ? {} : {
        reasoning: model.reasoning,
        reasoningEfforts: Object.fromEntries(model.reasoning.supported.map((effort) => [effort, effort === "low" ? "light" : effort === "xhigh" ? "extra_high" : "high"]))
      },
      ...wireModel.id !== "" && wireModel.id !== model.id ? { wireConfigName: wireModel.id } : {},
      ...wireModel.function === void 0 ? {} : { wireFunction: wireModel.function }
    });
  }
  return result;
}
function applyContextBudgets(catalog, budgets = {}) {
  return catalog.map((model) => ({
    ...model,
    ...model.maxContextWindow !== void 0 && budgets[model.id] === model.maxContextWindow ? { contextWindow: model.maxContextWindow } : {}
  }));
}
function sanitizeCatalog(catalog) {
  return catalog.filter((model) => {
    if (model.id.endsWith("@1m")) return false;
    const legacy = model;
    return legacy.baseModelId === void 0 && legacy.maxContext !== true;
  });
}
function deriveCatalog(catalog, enabled, budgets = {}) {
  return applyContextBudgets(enabled.size === 0 ? catalog : catalog.filter((model) => enabled.has(model.id)), budgets);
}
var TraeCatalog = class {
  models;
  /**
  * @param region Seeds the static fallback for this region; each region's
  * provider must never serve the other region's roster before its first live
  * refresh lands.
  */
  constructor(region = "cn") {
    this.models = fallbackModelsFor(region);
  }
  current() {
    return this.models;
  }
  set(models) {
    if (models.length === 0) throw new Error("trae model catalog cannot be empty");
    this.models = models.map((model) => ({
      ...model,
      ...model.input === void 0 ? {} : { input: [...model.input] }
    }));
  }
};
var TRAE_AUTH_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
var SALT_A = Uint8Array.from([
  82,
  9,
  106,
  213,
  48,
  54,
  165,
  56,
  191,
  64,
  163,
  158,
  129,
  243,
  215,
  251,
  124,
  227,
  57,
  130,
  155,
  47,
  255,
  135,
  52,
  142,
  67,
  68,
  196,
  222,
  233,
  203,
  84,
  123,
  148,
  50,
  166,
  194,
  35,
  61,
  238,
  76,
  149,
  11,
  66,
  250,
  195,
  78,
  8,
  46,
  161,
  102,
  40,
  217,
  36,
  178,
  118,
  91,
  162,
  73,
  109,
  139,
  209,
  37
]);
var SALT_B = Uint8Array.from([
  31,
  221,
  168,
  51,
  136,
  7,
  199,
  49,
  177,
  18,
  16,
  89,
  39,
  128,
  236,
  95,
  96,
  81,
  127,
  169,
  25,
  181,
  74,
  13,
  45,
  229,
  122,
  159,
  147,
  201,
  156,
  239,
  160,
  224,
  59,
  77,
  174,
  42,
  245,
  176,
  200,
  235,
  187,
  60,
  131,
  83,
  153,
  97,
  23,
  43,
  4,
  126,
  186,
  119,
  214,
  38,
  225,
  105,
  20,
  99,
  85,
  33,
  12,
  125
]);
var SALT_C = Uint8Array.from([
  191,
  192,
  216,
  250,
  122,
  246,
  220,
  97,
  31,
  254,
  98,
  27,
  8,
  72,
  71,
  176,
  135,
  99,
  96,
  18,
  127,
  101,
  203,
  104,
  211,
  102,
  191,
  125,
  37,
  72,
  150,
  156,
  51,
  229,
  121,
  35,
  17,
  153,
  141,
  177,
  110,
  131,
  150,
  128,
  172,
  255,
  254,
  6,
  18,
  140,
  55,
  62,
  236,
  249,
  135,
  64,
  135,
  12,
  117,
  4,
  89,
  149,
  168,
  209
]);
var SALT_D = Uint8Array.from([
  246,
  204,
  26,
  232,
  232,
  70,
  129,
  109,
  223,
  146,
  169,
  242,
  23,
  241,
  105,
  145,
  50,
  196,
  165,
  42,
  254,
  120,
  3,
  54,
  244,
  207,
  209,
  85,
  53,
  6,
  138,
  106,
  175,
  148,
  31,
  204,
  186,
  186,
  165,
  182,
  87,
  142,
  49,
  10,
  39,
  110,
  26,
  154,
  86,
  56,
  173,
  125,
  18,
  64,
  198,
  225,
  99,
  99,
  83,
  82,
  191,
  134,
  76,
  170
]);
function xor(a, b) {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)));
}
function encryptionType(header) {
  if (header.equals(Buffer.from([
    116,
    99,
    5,
    16,
    0,
    0
  ]))) return "aes";
  if (header.equals(Buffer.from([
    18,
    57,
    32,
    32,
    2,
    3
  ]))) return "aes-private";
  throw new Error("unsupported Trae auth encryption header");
}
function decryptTraeStorageValue(encoded) {
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length <= 102) throw new Error("Trae auth ciphertext is too short");
  const type = encryptionType(buffer.subarray(0, 6));
  const random = buffer.subarray(6, 38);
  const encrypted = buffer.subarray(38);
  const salt = type === "aes-private" ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const first = (0, import_node_crypto5.createHash)("sha512").update(random).digest();
  const derived = (0, import_node_crypto5.createHash)("sha512").update(Buffer.concat([first, salt])).digest();
  const decipher = (0, import_node_crypto5.createDecipheriv)("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error("Trae auth plaintext is too short");
  const expected = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actual = (0, import_node_crypto5.createHash)("sha512").update(plaintext).digest();
  if (!expected.equals(actual)) throw new Error("Trae auth integrity check failed");
  return plaintext.toString("utf8");
}
function parseTraeAuthValue(value) {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("Trae auth value is empty");
  const plaintext = trimmed.startsWith("{") ? trimmed : decryptTraeStorageValue(trimmed);
  return JSON.parse(plaintext);
}
function parseTraeStorageDocument(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Trae storage document must be an object");
  const value = parsed[TRAE_AUTH_STORAGE_KEY];
  if (typeof value !== "string") throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`);
  return parseTraeAuthValue(value);
}
function decodeBase64UrlJson(segment) {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return;
  }
}
function parseTraeCliToken(text) {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Trae CLI token file is empty");
  let token = trimmed;
  if (trimmed.startsWith("{")) {
    const envelope = JSON.parse(trimmed);
    const candidate = envelope["token"] ?? envelope["accessToken"] ?? envelope["jwt"];
    if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("Trae CLI token document has no token field");
    token = candidate.trim();
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) throw new Error("Trae CLI token is not a three-part JWT");
  const payload = decodeBase64UrlJson(segments[1]);
  if (payload === void 0) throw new Error("Trae CLI token payload is not decodable JSON");
  const data = typeof payload["data"] === "object" && payload["data"] !== null && !Array.isArray(payload["data"]) ? payload["data"] : void 0;
  const userId = typeof data?.["user_id"] === "string" ? data["user_id"] : void 0;
  if (userId === void 0 || userId === "") throw new Error("Trae CLI token has no data.user_id claim");
  const exp = payload["exp"];
  const expiresAtMs = typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : void 0;
  return {
    accessToken: token,
    userId,
    ...expiresAtMs === void 0 ? {} : { expiresAtMs }
  };
}
var APP_NAMES = {
  cn: "Trae CN",
  sg: "Trae",
  solo: "TRAE SOLO CN",
  "solo-sg": "TRAE SOLO"
};
var CLI_HOME_NAMES = [".trae-cn", ".trae"];
var TRAE_CLI_TOKEN_FILENAME = "trae-jwt-token";
var LINUX_APP_NAMES = {
  cn: [
    "trae-cn",
    "Trae CN",
    "trae",
    "Trae"
  ],
  sg: ["trae", "Trae"],
  solo: ["trae-solo-cn", "TRAE SOLO CN"],
  "solo-sg": ["trae-solo", "TRAE SOLO"]
};
var WINDOWS_APP_NAMES = {
  cn: ["Trae CN", "trae-cn"],
  sg: ["Trae"],
  solo: ["TRAE SOLO CN", "trae-solo-cn"],
  "solo-sg": ["TRAE SOLO"]
};
function traeWindowsAppNames(edition) {
  return WINDOWS_APP_NAMES[edition];
}
function traeStorageCandidates(platform = process.platform, home = (0, import_node_os2.homedir)(), env = process.env) {
  const result = [];
  for (const edition of [
    "cn",
    "sg",
    "solo",
    "solo-sg"
  ]) {
    const app = APP_NAMES[edition];
    let roots;
    let appNames;
    if (platform === "darwin") {
      roots = [(0, import_node_path6.join)(home, "Library", "Application Support")];
      appNames = [app];
    } else if (platform === "win32") {
      roots = [env.APPDATA, (0, import_node_path6.join)(home, "AppData", "Roaming")].filter((value, index, all) => typeof value === "string" && value !== "" && all.indexOf(value) === index);
      appNames = WINDOWS_APP_NAMES[edition];
    } else if (platform === "linux") {
      roots = [env.XDG_CONFIG_HOME || (0, import_node_path6.join)(home, ".config")];
      appNames = LINUX_APP_NAMES[edition];
    } else {
      roots = [];
      appNames = [app];
    }
    for (const root of roots) for (const appName of appNames) result.push({
      edition,
      path: (0, import_node_path6.join)(root, appName, "User", "globalStorage", "storage.json"),
      source: "desktop"
    });
  }
  return [...result, ...traeCliCandidates(platform, home, env)];
}
function traeCliCandidates(platform = process.platform, home = (0, import_node_os2.homedir)(), env = process.env) {
  const roots = [];
  if (platform === "win32") {
    for (const value of [env.USERPROFILE, home]) if (typeof value === "string" && value !== "" && !roots.includes(value)) roots.push(value);
  } else roots.push(home);
  const result = [];
  for (const root of roots) for (const name of CLI_HOME_NAMES) {
    const edition = name === ".trae-cn" ? "cn" : "sg";
    result.push({
      edition,
      path: (0, import_node_path6.join)(root, name, TRAE_CLI_TOKEN_FILENAME),
      source: "cli"
    });
  }
  return result;
}
var REGION_GATEWAYS = {
  cn: {
    chat: "https://trae-api-cn.mchost.guru",
    remote: "https://solo.trae.cn/api/remote/v1",
    pay: "https://api.trae.cn"
  },
  ai: {
    chat: "https://coresg-normal.trae.ai",
    remote: "https://coresg-normal.trae.ai/api/remote/v1",
    pay: "https://growsg-normal.trae.ai"
  }
};
function regionOfEdition(edition) {
  return edition === "sg" || edition === "solo-sg" ? "ai" : "cn";
}
function regionOfUserRegion(value) {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
  if (typeof raw !== "string") return void 0;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "cn") return "cn";
  if (lowered === "sg" || lowered === "ai") return "ai";
}
function regionOfHost(host) {
  if (host === void 0) return void 0;
  const trimmed = host.trim();
  if (trimmed === "") return void 0;
  let hostname2;
  try {
    hostname2 = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return;
  }
  if (hostname2 === "trae.ai" || hostname2.endsWith(".trae.ai")) return "ai";
  if (hostname2 === "trae.cn" || hostname2.endsWith(".trae.cn") || hostname2.endsWith(".trae.com.cn")) return "cn";
}
function regionOfCredential(credential) {
  return regionOfUserRegion(credential.userRegion) ?? regionOfHost(credential.host) ?? regionOfEdition(credential.edition);
}
var CLI_DEFAULT_HOST = "https://api.trae.cn";
var OWN_VERSION = 1;
var TRAE_AUTH_FILENAME = ".trae-auth.json";
var TRAE_OWN_PREFIX = ".trae-auth";
var ownDirOverride;
function setTraeOwnDir(dir) {
  ownDirOverride = typeof dir === "string" && dir !== "" ? dir : void 0;
}
function traeOwnDir() {
  return ownDirOverride ?? (0, import_node_path6.join)((0, import_node_os2.homedir)(), ".pi", "agent", "cache", "dsh-connect-trae");
}
function traeOwnAuthPath(region) {
  return (0, import_node_path6.join)(traeOwnDir(), `${TRAE_OWN_PREFIX}.${region}.json`);
}
function legacyTraeOwnAuthPath() {
  return (0, import_node_path6.join)(traeOwnDir(), TRAE_AUTH_FILENAME);
}
function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function timeToMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1e3;
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1e3;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function userRegionOf(value) {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value["region"] : value;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : void 0;
}
function normalizeTraeCredential(raw, edition, source) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
  const value = raw;
  const accessToken = optionalString(value["token"]) ?? optionalString(value["accessToken"]);
  if (accessToken === void 0) return void 0;
  const expiresAtMs = timeToMs(value["expiredAt"] ?? value["expiresAt"]) ?? 0;
  const refreshExpiresAtMs = timeToMs(value["refreshExpiredAt"] ?? value["refreshExpiresAt"]);
  const refreshToken = optionalString(value["refreshToken"]);
  const userRegion = userRegionOf(value["userRegion"]);
  const accountName = optionalString((typeof value["account"] === "object" && value["account"] !== null && !Array.isArray(value["account"]) ? value["account"] : void 0)?.["username"]);
  return {
    accessToken,
    ...refreshToken === void 0 ? {} : { refreshToken },
    userId: optionalString(value["userId"]) ?? "",
    ...accountName === void 0 ? {} : { accountName },
    host: optionalString(value["host"]) ?? "",
    ...userRegion === void 0 ? {} : { userRegion },
    expiresAtMs,
    ...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
    edition,
    source
  };
}
function traeAccountId(credential) {
  const stable = `${credential.edition}\0${credential.userId || credential.accountName || "unknown"}`;
  return (0, import_node_crypto5.createHash)("sha256").update(stable).digest("hex").slice(0, 24);
}
function parseOwn(text) {
  try {
    const document = JSON.parse(text);
    if (document.version !== OWN_VERSION || typeof document.credential !== "object" || document.credential === null) return void 0;
    const stored = document.credential;
    const edition = stored["edition"];
    if (edition !== "cn" && edition !== "sg" && edition !== "solo" && edition !== "solo-sg") return void 0;
    return normalizeTraeCredential({
      token: stored["accessToken"],
      refreshToken: stored["refreshToken"],
      userId: stored["userId"],
      host: stored["host"],
      userRegion: stored["userRegion"],
      account: stored["accountName"] === void 0 ? void 0 : { username: stored["accountName"] },
      expiredAt: stored["expiresAtMs"],
      refreshExpiredAt: stored["refreshExpiresAtMs"]
    }, edition, "dsh");
  } catch {
    return;
  }
}
var TraeCredentialStore = class {
  storagePathOverride;
  edition;
  accountId;
  region;
  ownPathExplicit;
  legacyOwnPath;
  legacyOwnPathExplicit;
  refresh;
  refreshMarginMs;
  inflight;
  constructor(options) {
    this.storagePathOverride = options.storagePath;
    this.edition = options.edition ?? "auto";
    this.accountId = options.accountId;
    this.region = options.region;
    this.ownPathExplicit = options.ownPath;
    this.legacyOwnPath = options.legacyOwnPath ?? legacyTraeOwnAuthPath();
    this.legacyOwnPathExplicit = options.legacyOwnPath;
    this.refresh = options.refresh;
    this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
  }
  /** Whether a credential's own claim belongs to this store's region. */
  matchesRegion(credential) {
    return this.region === void 0 || regionOfCredential(credential) === this.region;
  }
  /**
  * The path this store refreshes into: the per-region file for a
  * region-scoped store, the legacy single file otherwise, or an explicitly
  * injected path in tests.
  */
  ownAuthPath() {
    if (this.ownPathExplicit !== void 0) return this.ownPathExplicit;
    return this.region !== void 0 ? traeOwnAuthPath(this.region) : this.legacyOwnPath;
  }
  /**
  * Every plugin-owned copy to read, most preferred first. A region-scoped
  * store reads the legacy single copy as its migration source (readAll's
  * region filter drops it when it carries the other region's credential); an
  * unscoped store reads everything so diagnostics see both regions.
  *
  * With an explicitly injected own path the legacy source is read ONLY when
  * it was injected too — a test that pins one file must not accidentally see
  * the real machine's legacy copy.
  */
  ownCandidates() {
    if (this.ownPathExplicit !== void 0) return this.legacyOwnPathExplicit !== void 0 ? [this.ownPathExplicit, this.legacyOwnPathExplicit] : [this.ownPathExplicit];
    if (this.region !== void 0) return [traeOwnAuthPath(this.region), this.legacyOwnPath];
    return [
      this.legacyOwnPath,
      traeOwnAuthPath("cn"),
      traeOwnAuthPath("ai")
    ];
  }
  setSource(storagePath, edition = "auto", accountId) {
    this.storagePathOverride = storagePath;
    this.edition = edition;
    this.accountId = accountId;
    this.inflight = void 0;
  }
  selectAccount(accountId) {
    this.accountId = accountId;
    this.inflight = void 0;
  }
  candidates() {
    if (this.storagePathOverride !== void 0) {
      const edition = this.edition === "auto" ? "cn" : this.edition;
      return [{
        edition,
        path: this.storagePathOverride,
        source: "desktop"
      }, {
        edition,
        path: this.storagePathOverride,
        source: "cli"
      }];
    }
    const all = traeStorageCandidates();
    const cliEdition = "cn";
    return this.edition === "auto" ? all.filter((candidate) => candidate.source === "desktop" || candidate.edition === cliEdition) : all.filter((candidate) => candidate.edition === this.edition && (candidate.source === "desktop" || candidate.edition === cliEdition));
  }
  /**
  * Deterministic default when no account is explicitly selected: the first
  * discovered account. This is NOT credit-seeking — it never reorders accounts
  * to find one with general credits. The plugin bills exactly the account the
  * user selected, or the first account when nothing has been selected yet.
  */
  preferred(credentials) {
    return credentials[0];
  }
  async accounts() {
    const credentials = await this.readAll();
    const selectedExists = this.accountId !== void 0 && credentials.some((credential) => traeAccountId(credential) === this.accountId);
    const defaultSelected = this.preferred(credentials);
    return credentials.map((credential) => ({
      id: traeAccountId(credential),
      accountName: credential.accountName ?? (credential.userId || `${credential.edition} account`),
      edition: credential.edition,
      region: regionOfCredential(credential),
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      selected: selectedExists ? traeAccountId(credential) === this.accountId : credential === defaultSelected
    }));
  }
  async current() {
    const credentials = await this.readAll();
    if (this.accountId === void 0) return this.preferred(credentials);
    return credentials.find((credential) => traeAccountId(credential) === this.accountId);
  }
  async resolve() {
    const credential = await this.current();
    if (credential === void 0) throw new Error(`trae: no signed-in account found (${this.candidates().map((item) => item.path).join(" or ")})`);
    if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential;
    this.inflight ??= this.refreshNow(credential).finally(() => {
      this.inflight = void 0;
    });
    return this.inflight;
  }
  async status() {
    try {
      const value = await this.current();
      return value === void 0 ? { state: "signed-out" } : {
        state: "signed-in",
        edition: value.edition,
        expiresAtMs: value.expiresAtMs,
        source: value.source
      };
    } catch {
      return { state: "signed-out" };
    }
  }
  async desktopFilePresent() {
    for (const candidate of this.candidates()) try {
      if ((await (0, import_promises.stat)(candidate.path)).isFile()) return true;
    } catch {
    }
    return false;
  }
  /**
  * Remove every plugin-owned copy this store could read (per-region file,
  * legacy single file, and their lock siblings); the desktop storage files
  * are untouched. A region store's logout therefore also clears the legacy
  * migration source — deliberate: `logout` is the user's "forget what the
  * plugin stored" action, not a per-account toggle.
  */
  async logout() {
    for (const path of this.ownCandidates()) {
      await (0, import_promises.rm)(path, { force: true });
      await (0, import_promises.rm)(`${path}.lock`, { force: true });
    }
  }
  /**
  * Every local credential of this store's region, deduplicated by account id.
  * A region-scoped store sees only its own region's credentials: the other
  * region's accounts are invisible to selection, refresh, and status alike,
  * which is what keeps the two regions' providers from cross-billing.
  */
  async readAll() {
    const { credentials: desktop } = await this.readDesktopAll();
    const credentials = [...desktop.filter((credential) => this.matchesRegion(credential))];
    for (const own of await this.readOwns()) {
      if (!this.matchesRegion(own)) continue;
      if (credentials.some((credential) => traeAccountId(credential) === traeAccountId(own))) continue;
      credentials.push(own);
    }
    return credentials;
  }
  /**
  * Which paths were tried and why each one failed. Read-only and token-free:
  * it exists so a signed-out card can explain itself instead of showing a bare
  * "not signed in", which is undiagnosable on a machine whose layout differs
  * from the ones the plugin was written against.
  */
  async diagnose() {
    const tried = this.candidates();
    const failures = [];
    for (const candidate of tried) {
      const raw = await (0, import_promises.readFile)(candidate.path, "utf8").then((text) => ({ text }), (error) => ({ error }));
      if ("error" in raw) {
        const code = typeof raw.error === "object" && raw.error !== null && "code" in raw.error ? raw.error.code : void 0;
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === "ENOENT" ? "missing" : "unreadable",
          ...code === "ENOENT" ? {} : { message: String(raw.error) }
        });
        continue;
      }
      try {
        this.credentialFrom(candidate, raw.text);
      } catch (error) {
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: "invalid",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      tried,
      failures
    };
  }
  /** Parse one candidate file's text into a credential, or throw. */
  credentialFrom(candidate, text) {
    let credential;
    if (candidate.source === "cli") {
      if (regionOfEdition(candidate.edition) !== "cn") throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`);
      const claims = parseTraeCliToken(text);
      credential = normalizeTraeCredential({
        token: claims.accessToken,
        userId: claims.userId,
        host: CLI_DEFAULT_HOST,
        expiredAt: claims.expiresAtMs
      }, candidate.edition, "cli");
    } else credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, "desktop");
    if (credential === void 0) throw new Error(`${candidate.source} candidate could not be normalized into a credential`);
    return credential;
  }
  async readDesktopAll() {
    const credentials = [];
    const failures = [];
    for (const candidate of this.candidates()) try {
      const credential = this.credentialFrom(candidate, await (0, import_promises.readFile)(candidate.path, "utf8"));
      if (!credentials.some((existing) => traeAccountId(existing) === traeAccountId(credential))) credentials.push(credential);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
      failures.push({
        path: candidate.path,
        edition: candidate.edition,
        source: candidate.source,
        reason: code === "ENOENT" ? "missing" : code === void 0 ? "invalid" : "unreadable",
        ...code === "ENOENT" || code === void 0 && !(error instanceof Error) ? {} : { message: error instanceof Error ? error.message : String(error) }
      });
      continue;
    }
    return {
      credentials,
      failures
    };
  }
  /**
  * Every readable plugin-owned copy, in candidate order; absent or corrupt
  * files are skipped rather than propagated.
  */
  async readOwns() {
    const copies = [];
    for (const path of this.ownCandidates()) try {
      const parsed = parseOwn(await (0, import_promises.readFile)(path, "utf8"));
      if (parsed !== void 0) copies.push(parsed);
    } catch {
    }
    return copies;
  }
  async refreshNow(credential) {
    if (credential.refreshToken === void 0 || credential.refreshExpiresAtMs !== void 0 && credential.refreshExpiresAtMs <= Date.now()) {
      if (credential.expiresAtMs > Date.now() + 3e4) return credential;
      throw new Error("trae: access token expired and no valid refresh token is available; sign in again in Trae");
    }
    try {
      const outcome = await this.refresh(credential);
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresAtMs,
        ...outcome.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
        ...outcome.host === void 0 ? {} : { host: outcome.host },
        source: "dsh"
      };
      const ownPath = this.ownAuthPath();
      await (0, import_promises.mkdir)((0, import_node_path6.dirname)(ownPath), { recursive: true });
      await (0, import_promises.writeFile)(ownPath, `${JSON.stringify({
        version: OWN_VERSION,
        credential: refreshed
      }, null, 2)}
`, { mode: 384 });
      return refreshed;
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 3e4) return credential;
      throw new Error(`trae: token refresh failed and access token is expired (${String(error)}); sign in again in Trae`);
    }
  }
};
var REFRESH_CONTRACT = {
  cn: {
    path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
    clientId: "ono9krqynydwx5",
    deviceInfo: false
  },
  sg: {
    path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
    clientId: "ono9krqynydwx5",
    deviceInfo: false
  },
  solo: {
    path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
    clientId: "ono9krqynydwx5",
    deviceInfo: false
  },
  "solo-sg": {
    path: "/trae/api/v3/oauth/ExchangeToken",
    clientId: "en1oxy7wnw8j9n",
    deviceInfo: true
  }
};
function normalizeHost(host) {
  const value = host.trim();
  if (value === "") throw new Error("Trae refresh host is missing");
  return value.replace(/\/$/, "");
}
async function refreshTraeCredential(credential, signal, device) {
  const contract = REFRESH_CONTRACT[credential.edition];
  if (contract === void 0) throw new Error(`Trae ${credential.edition} refresh contract is not verified`);
  if (credential.refreshToken === void 0) throw new Error("Trae refresh token is missing");
  const body = {
    ClientID: contract.clientId,
    ClientSecret: "-",
    RefreshToken: credential.refreshToken,
    UserID: credential.userId
  };
  if (contract.deviceInfo && device !== void 0) body["DeviceInfo"] = {
    DeviceID: device.deviceId,
    MachineID: device.machineId,
    PlatformCode: credential.edition === "solo-sg" ? "SOLO_PC" : "TRAE",
    DeviceType: "PC",
    DeviceName: (0, import_node_os2.hostname)()
  };
  const response = await fetch(`${normalizeHost(credential.host)}${contract.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(3e4)
  });
  if (!response.ok) throw new Error(`Trae token refresh failed (http ${response.status})`);
  const result = (await response.json()).Result;
  const accessToken = typeof result?.["Token"] === "string" ? result["Token"] : "";
  if (accessToken === "") throw new Error("Trae token refresh returned no token");
  const expiry = result?.["TokenExpireAt"];
  const expiresAtMs = typeof expiry === "number" ? expiry : typeof expiry === "string" ? Date.parse(expiry) : NaN;
  if (!Number.isFinite(expiresAtMs)) throw new Error("Trae token refresh returned an invalid expiry");
  const refreshToken = typeof result?.["RefreshToken"] === "string" && result["RefreshToken"] !== "" ? result["RefreshToken"] : void 0;
  return {
    accessToken,
    ...refreshToken === void 0 ? {} : { refreshToken },
    expiresAtMs
  };
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
function deviceCenterId(storage) {
  const prefix = "iCubeAuthInfo://icube-dc:";
  const ids = Object.keys(storage).filter((key) => key.startsWith(prefix)).map((key) => key.slice(25)).filter(Boolean);
  return ids.length === 1 ? ids[0] : void 0;
}
async function readTraeIdentity(candidate, options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (0, import_node_os2.homedir)();
  const env = options.env ?? process.env;
  const storage = JSON.parse(await (0, import_promises.readFile)(candidate.path, "utf8"));
  const appRoot = (0, import_node_path6.dirname)((0, import_node_path6.dirname)((0, import_node_path6.dirname)(candidate.path)));
  const machineFile = nonEmpty(await (0, import_promises.readFile)((0, import_node_path6.join)(appRoot, "machineid"), "utf8").catch(() => ""));
  const telemetryMachine = nonEmpty(storage["telemetry.machineId"]);
  const devDevice = nonEmpty(storage["telemetry.devDeviceId"]);
  const dcDevice = deviceCenterId(storage);
  const machineId = telemetryMachine ?? machineFile;
  if (machineId === void 0) throw new Error(`Trae ${candidate.edition} has no stable machine identity`);
  const deviceId = dcDevice ?? devDevice ?? (0, import_node_crypto5.createHash)("sha256").update(machineId).digest("hex").slice(0, 32);
  const buildVersion = nonEmpty(storage["iCubeLastVersion"]);
  const appName = {
    cn: "Trae CN",
    sg: "Trae",
    solo: "TRAE SOLO CN",
    "solo-sg": "TRAE SOLO"
  }[candidate.edition];
  const productPaths = [];
  if (appName !== void 0 && (platform === "darwin" || platform === "win32")) {
    if (platform === "darwin") productPaths.push((0, import_node_path6.join)("/Applications", `${appName}.app`, "Contents", "Resources", "app", "product.json"));
    else {
      const localRoots = [env.LOCALAPPDATA, (0, import_node_path6.join)(home, "AppData", "Local")].filter((value) => typeof value === "string" && value !== "").filter((value, index, all) => all.indexOf(value) === index);
      for (const root of localRoots) for (const spelling of traeWindowsAppNames(candidate.edition)) productPaths.push((0, import_node_path6.join)(root, "Programs", spelling, "resources", "app", "product.json"));
    }
  }
  let product = {};
  for (const path of productPaths) try {
    product = JSON.parse(await (0, import_promises.readFile)(path, "utf8"));
    break;
  } catch {
  }
  const appVersion = nonEmpty(product["appVersion"]);
  const deviceBrand = platform === "darwin" ? nonEmpty(env["TRAE_DEVICE_BRAND"]) : void 0;
  const deviceCpu = (0, import_node_os2.cpus)()[0]?.model.split(" ")[0];
  const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${(0, import_node_os2.release)()}`;
  return {
    edition: candidate.edition,
    machineId,
    deviceId,
    ...appVersion === void 0 ? {} : { appVersion },
    ...buildVersion === void 0 ? {} : { buildVersion },
    ...deviceBrand === void 0 ? {} : { deviceBrand },
    ...deviceCpu === void 0 ? {} : { deviceCpu },
    osVersion,
    platform
  };
}
function isFileMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
var STORAGE_MISSING_PREFIX = "Trae storage was not found";
async function pickTraeStorageIdentity(candidates, options = {}) {
  let lastError;
  let anyPresent = false;
  for (const candidate of candidates) try {
    return await readTraeIdentity(candidate, options);
  } catch (error) {
    lastError = error;
    if (!isFileMissing(error)) anyPresent = true;
  }
  const tried = candidates.map((item) => item.path).join(" or ");
  if (!anyPresent) throw new Error(`${STORAGE_MISSING_PREFIX} (${tried})`);
  throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`Trae identity could not be resolved (${tried})`);
}
var CLI_HOME_BY_EDITION = {
  cn: ".trae-cn",
  solo: ".trae-cn",
  sg: ".trae",
  "solo-sg": ".trae"
};
async function readTraeCliIdentity(edition, options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? (0, import_node_os2.homedir)();
  const env = options.env ?? process.env;
  const cliHome = (0, import_node_path6.join)(home, CLI_HOME_BY_EDITION[edition]);
  const argv = await readJsonFile((0, import_node_path6.join)(cliHome, "argv.json"));
  const version = await readJsonFile((0, import_node_path6.join)(cliHome, "builtin", "ide_version.json"));
  const crashReporterId = nonEmpty(argv?.["crash-reporter-id"]);
  const host = nonEmpty(env["HOSTNAME"]) ?? await readHostname() ?? "unknown-host";
  const user = nonEmpty(env["USER"]) ?? nonEmpty(env["USERNAME"]) ?? "unknown-user";
  const deviceId = crashReporterId ?? (0, import_node_crypto5.createHash)("sha256").update(`trae-cli\0${host}\0${user}`).digest("hex").slice(0, 32);
  const machineId = (0, import_node_crypto5.createHash)("sha256").update(`trae-cli-machine\0${deviceId}\0${host}`).digest("hex");
  const appVersion = nonEmpty(version?.["version"]);
  const deviceCpu = (0, import_node_os2.cpus)()[0]?.model.split(" ")[0];
  const osVersion = `${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform} ${(0, import_node_os2.release)()}`;
  return {
    edition,
    machineId,
    deviceId,
    ...appVersion === void 0 ? {} : { appVersion },
    ...deviceCpu === void 0 ? {} : { deviceCpu },
    osVersion,
    platform
  };
}
async function readJsonFile(path) {
  try {
    const parsed = JSON.parse(await (0, import_promises.readFile)(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return;
  }
}
async function readHostname() {
  try {
    const { hostname: hostname2 } = await import("node:os");
    return nonEmpty(hostname2());
  } catch {
    return;
  }
}
async function resolveTraeIdentity(candidates, edition, options = {}) {
  try {
    return await pickTraeStorageIdentity(candidates, options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(STORAGE_MISSING_PREFIX)) throw error;
    return readTraeCliIdentity(edition, options);
  }
}
function identityHeaders(identity) {
  return {
    "x-machine-id": identity.machineId,
    "x-device-id": identity.deviceId,
    "x-device-type": identity.platform === "darwin" ? "mac" : identity.platform === "win32" ? "windows" : identity.platform,
    ...identity.deviceBrand === void 0 ? {} : { "x-device-brand": identity.deviceBrand },
    ...identity.deviceCpu === void 0 ? {} : { "x-device-cpu": identity.deviceCpu },
    ...identity.osVersion === void 0 ? {} : { "x-os-version": identity.osVersion },
    ...identity.appVersion === void 0 ? {} : {
      "x-app-version": identity.appVersion,
      "x-ide-version": identity.appVersion
    },
    ...identity.buildVersion === void 0 ? {} : {
      "x-app-version-code": identity.buildVersion,
      "x-ide-version-code": identity.buildVersion
    },
    "x-ide-version-type": "stable"
  };
}
var BODY_LIMIT = 67108864;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
  "127.0.0.1",
  "localhost",
  "[::1]"
]);
var STATUS_BY_KIND = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 502,
  server: 502,
  client: 400,
  unconfigured: 503
};
function hostnameOfHost(host) {
  let hostname2 = host.trim().toLowerCase();
  if (hostname2.startsWith("[")) {
    const end = hostname2.indexOf("]");
    return end === -1 ? hostname2 : hostname2.slice(0, end + 1);
  }
  const colon = hostname2.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(hostname2.slice(colon + 1))) hostname2 = hostname2.slice(0, colon);
  return hostname2;
}
function hostIsLoopback2(host) {
  return host !== void 0 && host.trim() !== "" && LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback2(origin) {
  if (origin === void 0 || origin.trim() === "") return true;
  try {
    const hostname2 = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(hostname2) || hostname2 === "::1";
  } catch {
    return false;
  }
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function writeError2(res, status, kind, message) {
  writeJson(res, status, { error: {
    message,
    type: kind,
    code: kind
  } });
}
function readBody2(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(/* @__PURE__ */ new Error("request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function createTraeShim(options) {
  const injectedSecret = options?.["secret"];
  const preferredPort = options?.["preferredPort"];
  const refreshCatalog = options?.["refreshCatalog"];
  const secret = typeof injectedSecret === "string" && injectedSecret.length > 0 ? injectedSecret : (0, import_node_crypto5.randomBytes)(32).toString("base64url");
  const sockets = /* @__PURE__ */ new Set();
  const server = (0, import_node_http2.createServer)((req, res) => {
    handle(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const attemptBind = (port) => new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });
  const ready = (async () => {
    const preferred = typeof preferredPort === "number" && Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : 0;
    if (preferred === 0) {
      await attemptBind(0);
      return;
    }
    try {
      await attemptBind(preferred);
    } catch (error) {
      if (error?.["code"] !== "EADDRINUSE") throw error;
      options?.logger?.warn?.(`dsh-connect-trae: \u7AEF\u53E3 ${preferred} \u5DF2\u88AB\u5360\u7528\uFF0C\u6539\u7528\u968F\u673A\u7AEF\u53E3\uFF08\u6A21\u578B\u6863\u6848\u91CC\u7684 Base URL \u9700\u8981\u66F4\u65B0\uFF09`);
      await attemptBind(0);
    }
  })();
  server.unref();
  function bearerOk(req) {
    const match = typeof req.headers.authorization === "string" ? /^Bearer\s+(.+)$/i.exec(req.headers.authorization.trim()) : null;
    if (match === null) return false;
    const actual = Buffer.from(match[1] ?? "");
    const expected = Buffer.from(secret);
    return actual.length === expected.length && (0, import_node_crypto5.timingSafeEqual)(actual, expected);
  }
  async function handle(req, res) {
    try {
      if (!hostIsLoopback2(req.headers.host)) return writeError2(res, 403, "host_not_allowed", "Host must be loopback");
      if (!originIsLoopback2(req.headers.origin)) return writeError2(res, 403, "origin_not_allowed", "Origin must be loopback");
      if (!bearerOk(req)) return writeError2(res, 401, "unauthorized", "Missing or invalid bearer");
      const url = req.url ?? "/";
      const catalogRoute = req.method === "GET" && (url === "/v1/models" || url === "/v1/models/") || req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/");
      if (catalogRoute && typeof refreshCatalog === "function") {
        const haveModels = options.catalog.current().length > 0;
        const refreshed = (async () => {
          try {
            return await refreshCatalog();
          } catch (error) {
            options?.logger?.warn?.("dsh-connect-trae: \u8BF7\u6C42\u524D\u6A21\u578B\u76EE\u5F55\u5237\u65B0\u5931\u8D25\uFF0C\u4F7F\u7528\u7F13\u5B58\u76EE\u5F55", error);
            return void 0;
          }
        })();
        if (!haveModels) await refreshed;
      }
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) return writeJson(res, 200, { ok: true });
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) return writeJson(res, 200, {
        object: "list",
        data: options.catalog.current().map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "trae"
        }))
      });
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
        if (typeof req.headers["content-type"] !== "string" || !req.headers["content-type"].toLowerCase().startsWith("application/json")) return writeError2(res, 415, "unsupported_media_type", "Content-Type must be application/json");
        const raw = (await readBody2(req)).toString("utf8");
        try {
          JSON.parse(raw);
        } catch {
          return writeError2(res, 400, "invalid_json", "Request body must be valid JSON");
        }
        const parsed = JSON.parse(raw);
        options.logger?.info("dsh-connect-trae: chat request received", {
          model: parsed.model,
          messages: Array.isArray(parsed.messages) ? parsed.messages.map((message) => typeof message === "object" && message !== null ? message["role"] ?? "?" : "?") : "(none)",
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
          maxTokens: parsed.max_tokens,
          reasoningEffort: parsed.reasoning_effort,
          temperature: parsed.temperature,
          bodyBytes: raw.length
        });
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        req.socket.once("close", abort);
        const result = await options.client.chatStream(raw, controller.signal);
        if (!result.ok) return writeError2(res, STATUS_BY_KIND[result.kind], result.kind, result.message);
        if (parsed.stream !== true) {
          const textDecoder = new TextDecoder();
          const textParts = [];
          const reasoningParts = [];
          const toolCallMap = /* @__PURE__ */ new Map();
          let finishReason = "stop";
          let usage;
          const absorbChunk = (chunk) => {
            if (chunk !== null && typeof chunk === "object" && chunk["usage"] !== void 0 && chunk["usage"] !== null) usage = chunk["usage"];
            const choice = Array.isArray(chunk?.["choices"]) ? chunk["choices"][0] : void 0;
            if (choice === void 0) return;
            const delta = choice["delta"];
            if (delta !== null && typeof delta === "object") {
              if (typeof delta["content"] === "string" && delta["content"] !== "") textParts.push(delta["content"]);
              if (typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "") reasoningParts.push(delta["reasoning_content"]);
              if (Array.isArray(delta["tool_calls"])) {
                for (const call of delta["tool_calls"]) {
                  if (call === null || typeof call !== "object") continue;
                  const index = typeof call["index"] === "number" ? call["index"] : toolCallMap.size;
                  const existing = toolCallMap.get(index) ?? {
                    id: void 0,
                    type: "function",
                    function: { name: "", arguments: "" }
                  };
                  if (typeof call["id"] === "string" && call["id"] !== "") existing.id = call["id"];
                  if (typeof call["type"] === "string" && call["type"] !== "") existing.type = call["type"];
                  const fn = call["function"];
                  if (fn !== null && typeof fn === "object") {
                    if (typeof fn["name"] === "string" && fn["name"] !== "" && existing["function"].name === "") existing["function"].name = fn["name"];
                    if (typeof fn["arguments"] === "string" && fn["arguments"] !== "") existing["function"].arguments += fn["arguments"];
                  }
                  toolCallMap.set(index, existing);
                }
              }
            }
            if (typeof choice["finish_reason"] === "string" && choice["finish_reason"] !== "") finishReason = choice["finish_reason"];
          };
          let upstreamError;
          try {
            let buffer = "";
            const absorbLine = (line) => {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) return;
              const payload = trimmed.slice(5).trim();
              if (payload === "" || payload === "[DONE]") return;
              try {
                absorbChunk(JSON.parse(payload));
              } catch {
              }
            };
            for await (const piece of import_node_stream.Readable.fromWeb(result.response.body)) {
              buffer += textDecoder.decode(piece, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) absorbLine(line);
            }
            if (buffer !== "") absorbLine(buffer);
          } catch (error) {
            upstreamError = error instanceof Error ? error : new Error(String(error));
          }
          if (upstreamError !== void 0) return writeError2(res, 502, "upstream_error", upstreamError.message);
          const message = { role: "assistant", content: textParts.join("") };
          if (reasoningParts.length > 0) message["reasoning_content"] = reasoningParts.join("");
          if (toolCallMap.size > 0) {
            message["tool_calls"] = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({
              ...call.id === void 0 ? {} : { id: call.id },
              type: call.type,
              function: call["function"]
            }));
            if (finishReason === "stop") finishReason = "tool_calls";
          }
          return writeJson(res, 200, {
            id: `chatcmpl-${(0, import_node_crypto5.randomBytes)(8).toString("hex")}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1e3),
            model: typeof parsed.model === "string" ? parsed.model : "",
            choices: [{ index: 0, message, finish_reason: finishReason }],
            // Absent beats fabricated: a zero would read as "this turn cost nothing".
            ...usage === void 0 ? {} : { usage }
          });
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        const body = import_node_stream.Readable.fromWeb(result.response.body);
        body.on("error", (error) => {
          const record2 = error instanceof Error ? {
            name: error.name,
            message: error.message,
            cause: error.cause ? String(error.cause) : void 0
          } : String(error);
          options.logger?.warn("dsh-connect-trae: upstream stream failed", record2);
          if (!res.writableEnded) res.end();
        });
        body.pipe(res);
        return;
      }
      writeError2(res, 404, "not_found", `No such route: ${req.method} ${url}`);
    } catch (error) {
      options.logger?.error("dsh-connect-trae: shim request failed", error);
      if (!res.headersSent) writeError2(res, 500, "internal", "Internal shim error");
      else if (!res.writableEnded) res.end();
    }
  }
  return {
    ready,
    baseUrl() {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("trae shim is not listening");
      return `http://127.0.0.1:${address.port}`;
    },
    token: () => secret,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error === void 0 ? resolve() : reject(error));
    })
  };
}
var TRAE_VERSION_CODE_FALLBACK = "20260716";
function normalizeTraeVersionCode(buildVersion) {
  if (buildVersion === void 0 || buildVersion.trim() === "") return TRAE_VERSION_CODE_FALLBACK;
  const trimmed = buildVersion.trim();
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}
function buildTraeHeaders(credential, identity, options = {}) {
  const requestId = options.requestId ?? (0, import_node_crypto5.randomUUID)();
  const traceId = requestId.replaceAll("-", "").slice(0, 32);
  const profile = options.profile ?? "agent-task";
  const common = {
    "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
    "X-Ide-Token": credential.accessToken,
    "x-plugin-channel": "icube-ai",
    "User-Agent": `Trae/${identity.appVersion ?? identity.buildVersion ?? "unknown"}`,
    "x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ...identityHeaders(identity),
    "x-app-version-code": normalizeTraeVersionCode(identity.buildVersion),
    "x-ide-version-code": normalizeTraeVersionCode(identity.buildVersion),
    "x-custom-trace-id": traceId,
    "x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
    "request-traffic-type": "prod",
    "Content-Type": "application/json"
  };
  if (profile === "native-curl") return {
    "Content-Type": "application/json",
    "request-traffic-type": "prod",
    "x-app-id": options.appId ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    ...identityHeaders(identity),
    "x-custom-trace-id": traceId,
    "x-flow-traceparent": `04-${traceId}-${traceId.slice(0, 16)}-01`,
    "X-Ide-Token": credential.accessToken
  };
  if (profile === "model-detail") return {
    ...common,
    "Accept": "application/json"
  };
  if (profile === "raw-chat") return {
    ...common,
    "Accept": "text/event-stream"
  };
  return {
    ...common,
    "X-Cloudide-Token": credential.accessToken,
    "x-uid": credential.userId,
    "x-request-id": requestId,
    "x-trae-request-id": requestId,
    "Accept": "text/event-stream"
  };
}
var buildTraeCnHeaders = buildTraeHeaders;
function traeEndpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
var TRAE_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
function parseReasoningCapability(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const record2 = value;
  const supported = (Array.isArray(record2["reasoning_effort_options"]) ? record2["reasoning_effort_options"] : []).filter((item) => typeof item === "string" && TRAE_REASONING_EFFORTS.includes(item));
  const rawDefault = record2["default_reasoning_effort"];
  const defaultEffort = typeof rawDefault === "string" && supported.includes(rawDefault) ? rawDefault : void 0;
  if (supported.length === 0 && defaultEffort === void 0) return void 0;
  return {
    supported,
    ...defaultEffort === void 0 ? {} : { defaultEffort }
  };
}
var TRAE_SOLO_FUNCTION = "solo_work_lite";
var TRAE_DIRECTORY_FUNCTIONS = {
  cn: ["solo_work_remote", TRAE_SOLO_FUNCTION],
  ai: [
    "solo_agent",
    "solo_work_remote",
    TRAE_SOLO_FUNCTION
  ]
};
var TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
var TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
function classify(status) {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "hard_credit";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}
function finitePositive$1(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function prepareSoloBody(source, defaultModel = "glm-5.2", functionName) {
  const input = JSON.parse(source);
  const model = typeof input["model"] === "string" && input["model"].trim() !== "" ? input["model"].trim() : defaultModel;
  const body = {
    ...Array.isArray(input["messages"]) ? { messages: input["messages"] } : {},
    model,
    config_name: model,
    function: typeof input["function"] === "string" && input["function"] !== "" ? input["function"] : functionName ?? "solo_work_lite",
    stream: true,
    ...Array.isArray(input["tools"]) ? { tools: input["tools"] } : {},
    ...typeof input["reasoning_effort"] === "string" ? { reasoning_effort: input["reasoning_effort"] } : {}
  };
  if (Array.isArray(body["messages"])) for (const raw of body["messages"]) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw;
    if (message["role"] === "developer") message["role"] = "system";
    if (typeof message["content"] === "string") message["content"] = [{
      type: "text",
      text: message["content"]
    }];
    if (message["role"] === "assistant" && Array.isArray(message["tool_calls"])) for (const rawCall of message["tool_calls"]) {
      if (typeof rawCall !== "object" || rawCall === null) continue;
      const call = rawCall;
      if (typeof call["function"] === "object" && call["function"] !== null) {
        call["function_call"] = call["function"];
        delete call["function"];
      }
    }
    if (message["role"] === "tool") {
      message["role"] = "tool";
      if (typeof message["tool_call_id"] !== "string" || message["tool_call_id"] === "") throw new Error("Trae SOLO tool message requires tool_call_id");
    }
  }
  if (Array.isArray(body["tools"])) for (const raw of body["tools"]) {
    if (typeof raw !== "object" || raw === null) continue;
    const fn = raw["function"];
    if (typeof fn !== "object" || fn === null) continue;
    const record2 = fn;
    if (typeof record2["parameters"] === "object" && record2["parameters"] !== null) record2["parameters"] = JSON.stringify(record2["parameters"]);
  }
  return JSON.stringify(body);
}
function wireCreditMultiplier(config) {
  const raw = config["display_contact_config"];
  if (typeof raw !== "string" || raw === "") return void 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return void 0;
  const consumption = parsed["consumption_rate"];
  if (typeof consumption !== "object" || consumption === null) return void 0;
  const entry = consumption;
  if (entry["enable"] !== true) return void 0;
  const data = entry["data"];
  if (typeof data !== "object" || data === null) return void 0;
  return finitePositive$1(data["rate"]);
}
var TraeSoloUpstreamClient = class {
  options;
  fetchImpl;
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  /**
  * Read the callable roster for this credential's region.
  *
  * Every function in {@link TRAE_DIRECTORY_FUNCTIONS} is asked, in order, and
  * their answers are unioned: the first function to list a `config_name` owns
  * it. Trae splits its roster across SOLO modes, and a model is only callable
  * through the function that lists it (glm-5.3 exists solely under
  * `solo_work_remote` on the CN gateway). Asking one function therefore
  * silently hides models that the other one serves. The remote directory
  * remains the merge skeleton, so agent-internal entries (search_agent_*,
  * paygo variants) never surface even though they appear here.
  */
  async fetchModels(signal) {
    return (await this.fetchModelsDetailed(signal)).models;
  }
  /**
  * Read the callable roster, keeping the per-function failures.
  *
  * Returns `{ models, failures }`. A partial union is still returned: the
  * models the answering functions listed are callable, and refusing them
  * would take the whole region down for an account that has no access to one
  * of the modes — a deterministic condition, not a transient one. `failures`
  * lets the caller retry instead of caching the gap for a full directory TTL.
  *
  * @returns `{ models, failures }`; throws only when nothing was discovered.
  */
  async fetchModelsDetailed(signal) {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    const region = regionOfCredential(credential);
    const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat;
    const headers = {
      ...buildTraeCnHeaders(credential, identity),
      Accept: "application/json"
    };
    const byId = /* @__PURE__ */ new Map();
    const failures = [];
    for (const directoryFunction of TRAE_DIRECTORY_FUNCTIONS[region]) {
      let list;
      try {
        const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
          method: "POST",
          headers,
          body: JSON.stringify({
            function: directoryFunction,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null
          }),
          signal: signal ?? AbortSignal.timeout(3e4)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const document = await response.json();
        list = Array.isArray(document["config_info_list"]) ? document["config_info_list"] : [];
      } catch (error) {
        failures.push(`${directoryFunction}: ${String(error).slice(0, 80)}`);
        continue;
      }
      this.collectModels(list, directoryFunction, byId);
    }
    const models = [...byId.values()];
    if (models.length === 0) throw new Error(`Trae SOLO models response contained no models (${failures.join("; ") || "empty directory"})`);
    return { models, failures };
  }
  /** Merge one function's config list into the shared catalogue (first wins). */
  collectModels(list, directoryFunction, byId) {
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      const config = raw;
      const id = typeof config["config_name"] === "string" ? config["config_name"] : "";
      if (id === "") continue;
      const display = typeof config["display_config"] === "object" && config["display_config"] !== null ? config["display_config"] : {};
      const details = Array.isArray(config["model_detail_list"]) ? config["model_detail_list"] : [];
      const detail = typeof details[0] === "object" && details[0] !== null ? details[0] : {};
      const contextTokens = typeof config["context_window_tokens"] === "object" && config["context_window_tokens"] !== null ? config["context_window_tokens"] : {};
      const promptMaxTokens = finitePositive$1(detail["prompt_max_tokens"]);
      const devTokens = finitePositive$1(contextTokens["dev"]);
      const contextWindow = promptMaxTokens ?? devTokens;
      const maxTokens = finitePositive$1(detail["max_tokens"]);
      const reasoning = parseReasoningCapability({
        ...config,
        ...detail
      });
      const creditMultiplier = wireCreditMultiplier(config);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        name: typeof display["display_name"] === "string" && display["display_name"] !== "" ? display["display_name"] : id,
        ...contextWindow === void 0 ? {} : { contextWindow },
        ...maxTokens === void 0 ? {} : { maxTokens },
        ...reasoning === void 0 ? {} : { reasoning },
        ...creditMultiplier === void 0 ? {} : { creditMultiplier },
        function: directoryFunction
      });
    }
  }
  async chatStream(bodyJson, signal, functionName) {
    let prepared;
    try {
      prepared = prepareSoloBody(bodyJson, void 0, functionName);
    } catch {
      return {
        ok: false,
        status: 400,
        kind: "client",
        message: "invalid JSON request"
      };
    }
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()]);
    const headers = buildTraeCnHeaders(credential, identity);
    const base = this.options.baseUrl ?? REGION_GATEWAYS[regionOfCredential(credential)].chat;
    let response;
    try {
      response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
        method: "POST",
        headers,
        body: prepared,
        signal: signal ?? AbortSignal.timeout(12e4)
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        kind: "server",
        message: `transport error: ${String(error)}`
      };
    }
    if (response.ok) return {
      ok: true,
      response
    };
    const text = (await response.text()).slice(0, 1024);
    this.options.log?.("dsh-connect-trae: llm_utils_chat rejected", {
      status: response.status,
      model: JSON.parse(prepared)["model"],
      configName: JSON.parse(prepared)["config_name"],
      reasoningEffort: JSON.parse(prepared)["reasoning_effort"],
      body: text
    });
    return {
      ok: false,
      status: response.status,
      kind: classify(response.status),
      message: text || `Trae SOLO returned HTTP ${response.status}`
    };
  }
};
var SseDecoder = class {
  buffer = "";
  event;
  id;
  retry;
  data = [];
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    while (true) {
      const match = /\r?\n/.exec(this.buffer);
      if (match === null || match.index === void 0) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const emitted = this.consumeLine(line);
      if (emitted !== void 0) events.push(emitted);
    }
    return events;
  }
  finish() {
    const events = [];
    if (this.buffer !== "") {
      const emitted = this.consumeLine(this.buffer);
      this.buffer = "";
      if (emitted !== void 0) events.push(emitted);
    }
    const final = this.dispatch();
    if (final !== void 0) events.push(final);
    return events;
  }
  consumeLine(line) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return void 0;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }
  dispatch() {
    if (this.data.length === 0) {
      this.event = void 0;
      this.retry = void 0;
      return;
    }
    const result = {
      ...this.event === void 0 || this.event === "" ? {} : { event: this.event },
      data: this.data.join("\n"),
      ...this.id === void 0 ? {} : { id: this.id },
      ...this.retry === void 0 ? {} : { retry: this.retry }
    };
    this.event = void 0;
    this.retry = void 0;
    this.data = [];
    return result;
  }
};
function decodeTraeEvent(event) {
  if (event.data === "[DONE]") return {
    type: "done",
    finishReason: "stop"
  };
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return {
      type: "unknown",
      ...event.event === void 0 ? {} : { event: event.event },
      data: event.data
    };
  }
  const record2 = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {};
  if (event.event === "request_wait_in_queue") return {
    type: "queue",
    ...typeof record2["position"] === "number" ? { position: record2["position"] } : {}
  };
  if (event.event === "progress_notice") return {
    type: "progress",
    notice: payload
  };
  if (event.event === "token_usage") return {
    type: "usage",
    ...typeof record2["prompt_tokens"] === "number" ? { inputTokens: record2["prompt_tokens"] } : {},
    ...typeof record2["completion_tokens"] === "number" ? { outputTokens: record2["completion_tokens"] } : {},
    ...typeof record2["total_tokens"] === "number" ? { totalTokens: record2["total_tokens"] } : {},
    ...typeof record2["reasoning_tokens"] === "number" ? { reasoningTokens: record2["reasoning_tokens"] } : {},
    ...typeof record2["cache_read_input_tokens"] === "number" ? { cacheReadTokens: record2["cache_read_input_tokens"] } : {},
    ...typeof record2["cache_creation_input_tokens"] === "number" ? { cacheWriteTokens: record2["cache_creation_input_tokens"] } : {}
  };
  if (event.event === "done" || typeof record2["finish_reason"] === "string" && record2["response"] === void 0) return {
    type: "done",
    finishReason: typeof record2["finish_reason"] === "string" ? record2["finish_reason"] : "stop"
  };
  if (event.event === "output" || record2["response"] !== void 0 || record2["reasoning_content"] !== void 0) return {
    type: "delta",
    text: typeof record2["response"] === "string" ? record2["response"] : "",
    ...typeof record2["reasoning_content"] === "string" ? { reasoning: record2["reasoning_content"] } : {},
    ...record2["tool_calls"] === void 0 || record2["tool_calls"] === null ? {} : { toolCalls: record2["tool_calls"] }
  };
  return {
    type: "unknown",
    ...event.event === void 0 ? {} : { event: event.event },
    data: payload
  };
}
function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  const calls = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record2 = raw;
    const rawFunction = typeof record2["function_call"] === "object" && record2["function_call"] !== null ? record2["function_call"] : typeof record2["function"] === "object" && record2["function"] !== null ? record2["function"] : {};
    const fn = {
      ...typeof rawFunction["name"] === "string" ? { name: rawFunction["name"] } : {},
      ...typeof rawFunction["arguments"] === "string" ? { arguments: rawFunction["arguments"] } : {}
    };
    calls.push({
      index: typeof record2["index"] === "number" ? record2["index"] : calls.length,
      ...typeof record2["id"] === "string" ? { id: record2["id"] } : {},
      ...record2["type"] === "function" ? { type: "function" } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn }
    });
  }
  return calls;
}
function bridgeTraeSoloStream(response, model) {
  const source = response.body;
  if (source === null) return new Response(null, { status: 502 });
  const id = `chatcmpl-${(0, import_node_crypto5.randomUUID)().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1e3);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sse = new SseDecoder();
  let sawToolCalls = false;
  let emittedFinishReason = false;
  let upstreamEnded = false;
  let upstreamError;
  let usage;
  const chunk = (delta, finishReason = null) => encoder.encode(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }],
    ...usage === void 0 ? {} : { usage }
  })}

`);
  const stream = new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      const consume = (event) => {
        const decoded = decodeTraeEvent(event);
        if (decoded.type === "unknown") {
          const payload = decoded.data;
          const code = typeof payload?.["code"] === "number" ? payload["code"] : void 0;
          if (decoded.event === "error" || code !== void 0 && code >= 4e3) upstreamError = new Error(typeof payload?.["message"] === "string" && payload["message"] !== "" ? payload["message"] : `Trae upstream error (code ${code ?? "?"})`);
          return;
        }
        if (decoded.type === "delta") {
          const delta = {};
          if (decoded.text !== "") delta["content"] = decoded.text;
          if (decoded.reasoning !== void 0 && decoded.reasoning !== "") delta["reasoning_content"] = decoded.reasoning;
          const toolCalls = normalizeToolCalls(decoded.toolCalls);
          if (toolCalls.length > 0) {
            sawToolCalls = true;
            delta["tool_calls"] = toolCalls;
          }
          if (Object.keys(delta).length > 0) controller.enqueue(chunk(delta));
        } else if (decoded.type === "usage") {
          const cacheRead = decoded.cacheReadTokens;
          const cacheWrite = decoded.cacheWriteTokens;
          const details = {
            ...cacheRead === void 0 ? {} : { cached_tokens: cacheRead },
            ...cacheWrite === void 0 ? {} : { cache_write_tokens: cacheWrite }
          };
          usage = {
            ...decoded.inputTokens === void 0 ? {} : { prompt_tokens: decoded.inputTokens },
            ...decoded.outputTokens === void 0 ? {} : { completion_tokens: decoded.outputTokens },
            ...decoded.totalTokens === void 0 ? {} : { total_tokens: decoded.totalTokens },
            ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }
          };
        } else if (decoded.type === "done") {
          upstreamEnded = true;
          if (!emittedFinishReason) {
            emittedFinishReason = true;
            if (upstreamError !== void 0) {
              controller.error(upstreamError);
              return;
            }
            controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : decoded.finishReason || "stop"));
          }
        }
      };
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event);
        }
        for (const event of sse.finish()) consume(event);
        if (upstreamError !== void 0 && !upstreamEnded) {
          controller.error(upstreamError);
          return;
        }
        if (!emittedFinishReason) {
          emittedFinishReason = true;
          controller.enqueue(chunk({}, sawToolCalls ? "tool_calls" : "stop"));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return source.cancel(reason);
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}
var TraeSoloBridge = class {
  upstream;
  catalog;
  wireResolver;
  constructor(upstream, catalog, wireResolver) {
    this.upstream = upstream;
    this.catalog = catalog;
    this.wireResolver = wireResolver;
  }
  async chatStream(bodyJson, signal) {
    let model = "glm-5.2";
    let prepared = bodyJson;
    try {
      const input = JSON.parse(bodyJson);
      if (typeof input["model"] === "string" && input["model"] !== "") model = input["model"];
      const entry = this.catalog?.current().find((item) => item.id === model);
      const fromCatalog = entry?.wireConfigName === void 0 ? void 0 : {
        configName: entry.wireConfigName,
        ...entry.wireFunction === void 0 ? {} : { function: entry.wireFunction }
      };
      const fromResolver = this.wireResolver?.(model) ?? this.wireResolver?.(entry?.name ?? "");
      const target = fromCatalog ?? fromResolver;
      const wireModel = target?.configName ?? model;
      const wireFunction = target?.function ?? entry?.wireFunction;
      if (wireModel !== input["model"]) input["model"] = wireModel;
      if (wireFunction !== void 0 && input["function"] !== wireFunction) input["function"] = wireFunction;
      if (wireModel !== JSON.parse(bodyJson)["model"] || wireFunction !== void 0) prepared = JSON.stringify(input);
      if (typeof input["reasoning_effort"] === "string") {
        const efforts = entry?.reasoningEfforts;
        const requested = input["reasoning_effort"];
        const mapped = efforts?.[requested];
        const allowed = efforts === void 0 ? [] : Object.values(efforts).filter((value) => typeof value === "string");
        if (typeof mapped === "string") input["reasoning_effort"] = mapped;
        else if (!allowed.includes(requested)) delete input["reasoning_effort"];
        prepared = JSON.stringify(input);
      }
    } catch {
      return {
        ok: false,
        status: 400,
        kind: "client",
        message: "invalid JSON request"
      };
    }
    const result = await this.upstream.chatStream(prepared, signal);
    if (!result.ok) return result;
    return {
      ok: true,
      response: bridgeTraeSoloStream(result.response, model)
    };
  }
};
function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function parseFeatures(value) {
  if (typeof value !== "string" || value === "") return void 0;
  try {
    return record(JSON.parse(value));
  } catch {
    return;
  }
}
var EFFORT_MAP = {
  light: "low",
  high: "high",
  extra_high: "xhigh"
};
function parseTraeRemoteModel(value) {
  const raw = record(value);
  if (raw === void 0 || typeof raw.name !== "string" || raw.name === "") return void 0;
  const context = record(raw.context_window_tokens);
  const dev = finitePositive(context?.["dev"]);
  const max = raw.max_mode === true ? finitePositive(context?.["max"]) : void 0;
  const features = parseFeatures(raw.features);
  const consumption = record(features?.["consumption_rate"]);
  const consumptionData = record(consumption?.["data"]);
  const creditMultiplier = consumption?.["enable"] === true ? finitePositive(consumptionData?.["rate"]) : void 0;
  const reasoningSupported = record(features?.["reasoning"])?.["enable"] === true;
  const reasoningConfig = record(raw.reasoning_effort_config);
  const supported = (Array.isArray(reasoningConfig?.["options"]) ? reasoningConfig["options"] : []).flatMap((option) => {
    if (typeof option !== "string") return [];
    const effort = EFFORT_MAP[option];
    return effort === void 0 ? [] : [effort];
  });
  const rawDefault = reasoningConfig?.["default_level"];
  const mappedDefault = typeof rawDefault === "string" ? EFFORT_MAP[rawDefault] : void 0;
  const defaultEffort = mappedDefault !== void 0 && supported.includes(mappedDefault) ? mappedDefault : void 0;
  return {
    id: raw.name,
    name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : raw.name,
    multimodal: raw.multimodal === true,
    ...dev === void 0 ? {} : { contextWindow: dev },
    ...max === void 0 ? {} : { maxContextWindow: max },
    ...creditMultiplier === void 0 ? {} : { creditMultiplier },
    reasoningSupported,
    ...supported.length === 0 ? {} : { reasoning: {
      supported,
      ...defaultEffort === void 0 ? {} : { defaultEffort }
    } }
  };
}
function remoteDressing(region) {
  return region === "ai" ? {
    referer: "https://coresg-normal.trae.ai/",
    timezone: "Asia/Singapore",
    language: "en"
  } : {
    referer: "https://solo.trae.cn/",
    timezone: "Asia/Shanghai",
    language: "zh-cn"
  };
}
var TraeSoloRemoteCatalogClient = class {
  options;
  fetchImpl;
  baseUrl;
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl;
  }
  async headers(region) {
    const credential = await this.options.credential();
    const dressing = remoteDressing(region);
    return {
      "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
      "Content-Type": "application/json",
      "x-trae-client-type": "web",
      "x-trae-user-timezone": dressing.timezone,
      "x-preferenced-language": dressing.language,
      "Referer": dressing.referer,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    };
  }
  async fetchModels(signal) {
    const region = regionOfCredential(await this.options.credential());
    const base = this.baseUrl ?? REGION_GATEWAYS[region].remote;
    const headers = await this.headers(region);
    const response = await this.fetchImpl(`${base}/models?functions=solo_agent_remote,solo_work_remote`, {
      headers,
      signal: signal ?? AbortSignal.timeout(3e4)
    });
    if (!response.ok) throw new Error(`SOLO remote models returned HTTP ${response.status}`);
    const groups = (await response.json()).data?.list ?? [];
    const preferred = groups.find((group) => group.function === "solo_agent_remote") ?? groups[0];
    const seen = /* @__PURE__ */ new Set();
    const models = [];
    for (const raw of preferred?.models ?? []) {
      const model = parseTraeRemoteModel(raw);
      if (model === void 0 || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    if (models.length === 0) throw new Error("SOLO remote models response contained no models");
    return models;
  }
};
var execFileAsync2 = (0, import_node_util2.promisify)(import_node_child_process3.execFile);
var TraeDelegatingUpstreamClient = class {
  delegate;
  constructor(delegate) {
    this.delegate = delegate;
  }
  replace(delegate) {
    this.delegate = delegate;
  }
  chatStream(bodyJson, signal) {
    return this.delegate.chatStream(bodyJson, signal);
  }
};
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function parseUsageSnapshot(payload) {
  const summaryRaw = payload["usage_summary"];
  const summary = {
    totalAmount: asNumber(summaryRaw?.["total_amount"]) ?? 0,
    consumedAmount: asNumber(summaryRaw?.["consumed_amount"]) ?? 0,
    consumptionRatio: asNumber(summaryRaw?.["consumption_ratio"]) ?? 0
  };
  const trial = payload["trial_status"];
  const packs = [];
  const rawPacks = Array.isArray(payload["user_entitlement_pack_list"]) ? payload["user_entitlement_pack_list"] : [];
  for (const raw of rawPacks) {
    if (typeof raw !== "object" || raw === null) continue;
    const pack = raw;
    const base = pack["entitlement_base_info"];
    const quota = base?.["quota"];
    const usage = pack["usage"];
    const packageQuota = base?.["product_extra"]?.["package_extra"]?.["quota"];
    const creditsLimit = asNumber(packageQuota?.["credits_limit"]) ?? asNumber(quota?.["credits_limit"]);
    const consumedCredits = asNumber(usage?.["credits_amount"]);
    const availableEndpoint = asNumber(base?.["available_endpoint"]);
    packs.push({
      displayDesc: typeof pack["display_desc"] === "string" ? pack["display_desc"] : "",
      entitlementId: typeof base?.["entitlement_id"] === "string" ? base["entitlement_id"] : "",
      endTimeMs: asNumber(base?.["end_time"]) ?? 0,
      currency: asNumber(base?.["currency"]) ?? 0,
      ...availableEndpoint === void 0 ? {} : { availableEndpoint },
      ...creditsLimit === void 0 ? {} : { creditsLimit },
      ...consumedCredits === void 0 ? {} : { consumedCredits }
    });
  }
  return {
    isCreditsBilling: payload["is_credits_billing"] === true,
    isDollarUsageBilling: payload["is_dollar_usage_billing"] === true,
    isPayFreshman: payload["is_pay_freshman"] === true,
    inTrial: trial?.["is_in_trial"] === true,
    trialEndTimeMs: asNumber(trial?.["trial_end_time"]) ?? 0,
    summary,
    packs
  };
}
var TraeUsageClient = class {
  options;
  fetchImpl;
  baseUrl;
  timeoutMs;
  constructor(options) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 3e4;
  }
  /** Region of the current credential; `cn` when unresolvable. */
  async currentRegion() {
    const credential = await this.options.credential();
    return credential === void 0 ? "cn" : regionOfCredential(credential);
  }
  /**
  * Pay base for the current credential's region. An explicit baseUrl (tests,
  * diagnostics) pins the endpoint; otherwise CN uses `api.trae.cn` and the
  * international region its own verified pay gateway.
  */
  async payBase() {
    return this.baseUrl ?? REGION_GATEWAYS[await this.currentRegion()].pay;
  }
  /**
  * Device id for the check-in routes, or undefined when the machine's
  * installation identity cannot be read. Best-effort on purpose: a missing
  * identity must not break the read-only status query, which the upstream
  * answers with or without the header.
  */
  async deviceIdHeader() {
    try {
      const deviceId = await this.options.deviceId?.();
      return deviceId === void 0 || deviceId === "" ? {} : { "x-device-id": deviceId };
    } catch {
      return {};
    }
  }
  async authedHeaders() {
    const credential = await this.options.credential();
    if (credential === void 0 || credential.accessToken === "") throw new Error("Trae credential is not available; cannot query usage");
    const origin = await this.currentRegion() === "ai" ? "https://www.trae.ai" : "https://www.trae.cn";
    return {
      "Authorization": `Cloud-IDE-JWT ${credential.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "Origin": origin,
      "Referer": `${origin}/`
    };
  }
  async post(path, data, signal, extraHeaders = {}) {
    const headers = {
      ...await this.authedHeaders(),
      ...extraHeaders
    };
    const response = await this.fetchImpl(`${await this.payBase()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Trae usage endpoint ${path} returned HTTP ${response.status}`);
    return await response.json();
  }
  /**
  * Subscription/pay status of an international (ai) account. The CN region
  * never calls this (its contract is unverified there); the ai region uses
  * this instead of the Work-credit `snapshot`.
  */
  async payStatus(signal) {
    if (await this.currentRegion() !== "ai") throw new Error("Trae pay status is only available for the international (ai) region");
    const payload = await this.post("/trae/api/v1/pay/ide_user_pay_status", {}, signal);
    const flag = (key) => payload[key] === true;
    const trial = typeof payload["trial_status"] === "object" && payload["trial_status"] !== null ? payload["trial_status"] : {};
    const fissionStart = asNumber(payload["solo_fission_start_time"]);
    const fissionExpire = asNumber(payload["solo_fission_expire_time"]);
    const fissionMax = asNumber(payload["solo_fission_max_usage"]);
    return {
      isDollarUsageBilling: flag("is_dollar_usage_billing"),
      hasPackage: flag("has_package"),
      isPayFreshman: flag("is_pay_freshman") || flag("is_pay_freshman_v2"),
      inTrial: trial["is_in_trial"] === true,
      trialEndTimeMs: asNumber(trial["trial_end_time"]) ?? 0,
      enableSoloLite: flag("enable_solo_lite"),
      enableSoloBuilder: flag("enable_solo_builder"),
      enableSoloCoder: flag("enable_solo_coder"),
      enableSoloWeb: flag("enable_solo_web"),
      ...fissionStart === void 0 || fissionExpire === void 0 || fissionMax === void 0 ? {} : { fission: {
        startTimeMs: fissionStart,
        expireTimeMs: fissionExpire,
        maxUsage: fissionMax
      } }
    };
  }
  /**
  * The Work-credit endpoints are CN-only. The international region is
  * subscription-based and must read {@link payStatus} instead; guarding here
  * keeps the card's degraded `creditsError` message diagnosable rather than
  * letting an ai credential hit an unverified path on its pay gateway.
  */
  async requireCnRegion(method) {
    if (await this.currentRegion() !== "cn") throw new Error(`Trae ${method} is only available for the CN region; the international (ai) region uses payStatus`);
  }
  /** Total entitlements / credits and per-pack breakdown. */
  async snapshot(signal) {
    await this.requireCnRegion("usage snapshot");
    return parseUsageSnapshot(await this.post("/trae/api/v2/pay/web_user_ent_usage", { require_usage: true }, signal));
  }
  /**
  * Daily check-in status. Read-only, and answered with or without the device
  * header — the claim is what needs it.
  *
  * The read DOES carry the header whenever this installation has one, and
  * that is deliberate rather than incidental: `did_checked_in` is answered
  * per device, so omitting the header would make a device that already claimed
  * today look identical to one that never has (measured 2026-09-26, see
  * {@link TraeCheckinStatus.didCheckedIn}).
  */
  async checkinStatus(signal) {
    await this.requireCnRegion("check-in status");
    const headers = await this.deviceIdHeader();
    const payload = await this.post("/trae/api/v2/ug/checkin_credits/status", {}, signal, headers);
    const extraCredits = asNumber(payload["extra_credits"]);
    return {
      checkedIn: payload["checked_in"] === true,
      credits: asNumber(payload["credits"]) ?? 0,
      enabled: payload["enable"] !== false,
      didCheckedIn: payload["did_checked_in"] === true,
      ...extraCredits === void 0 || extraCredits <= 0 ? {} : { extraCredits }
    };
  }
  /**
  * Claim today's check-in reward. The ONLY state-changing call in this client.
  *
  * The upstream is idempotent per Beijing day (verified 2026-09-24: repeating
  * the call on an already-claimed day answers `code: 0` while the entitlement
  * total stays byte-identical), so a double click cannot double-grant. The
  * card and its route still guard, because "cannot double-grant" is a property
  * of the upstream we verify rather than one we rely on.
  *
  * A business refusal arrives as HTTP 200 with a non-zero `code` — most often
  * `9004` when the request carries no `x-device-id`. That is reported as
  * `claimed: false` rather than thrown, so the caller can tell "the upstream
  * refused this" apart from "the request never arrived".
  */
  async claimCheckin(signal) {
    await this.requireCnRegion("check-in claim");
    const headers = await this.deviceIdHeader();
    const payload = await this.post("/trae/api/v2/ug/checkin_credits/claim", {}, signal, headers);
    const code = asNumber(payload["code"]) ?? 0;
    return {
      claimed: code === 0,
      code,
      message: typeof payload["message"] === "string" ? payload["message"].slice(0, 200) : ""
    };
  }
  /** Rewards / activity rules. */
  async activities(signal) {
    await this.requireCnRegion("activities");
    const payload = await this.post("/trae/api/v2/ug/activity/info", {}, signal);
    const rawActivities = Array.isArray(payload["commercial_activities"]) ? payload["commercial_activities"] : [];
    const activities = [];
    for (const raw of rawActivities) {
      if (typeof raw !== "object" || raw === null) continue;
      const rule = raw;
      activities.push({
        activityId: typeof rule["activity_id"] === "string" ? rule["activity_id"] : "",
        enabled: rule["Enabled"] === true,
        activityType: asNumber(rule["activity_type"]) ?? 0,
        startTimeMs: asNumber(rule["start_time_ms"]) ?? 0,
        endTimeMs: asNumber(rule["end_time_ms"]) ?? 0,
        ...rule["work_extra"] === void 0 ? {} : { workExtra: rule["work_extra"] }
      });
    }
    return activities;
  }
  /** Convenience: snapshot + check-in + activities in one call (best-effort, non-fatal on missing). */
  async view(signal) {
    const [snapshot, checkin, activities] = await Promise.all([
      this.snapshot(signal),
      this.checkinStatus(signal),
      this.activities(signal)
    ]);
    return {
      snapshot,
      checkin,
      activities
    };
  }
};
var CHECKIN_DEVICE_ALREADY_CLAIMED = 9095;
function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function toCredits(snapshot) {
  const { totalAmount, consumedAmount } = snapshot.summary;
  const credit = (value) => Math.round(value * 1e4) / 1e4;
  const accounts = snapshot.packs.map((pack) => ({
    displayDesc: pack.displayDesc,
    remain: credit(Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))),
    size: pack.creditsLimit ?? 0
  }));
  const remaining = (endpoint) => snapshot.packs.filter((pack) => pack.availableEndpoint === endpoint).reduce((sum, pack) => credit(sum + Math.max(0, (pack.creditsLimit ?? 0) - (pack.consumedCredits ?? 0))), 0);
  return {
    total: totalAmount,
    consumed: consumedAmount,
    available: totalAmount - consumedAmount,
    workAvailable: remaining(1),
    generalAvailable: remaining(0),
    accounts
  };
}
function toCheckin(status) {
  return {
    checkedIn: status.checkedIn,
    didCheckedIn: status.didCheckedIn,
    credits: status.credits,
    enabled: status.enabled,
    ...status.extraCredits === void 0 ? {} : { extraCredits: status.extraCredits }
  };
}

// src/trae/runtime.js
var REGION_KEYS = ["cn", "ai"];
var CATALOG_TTL_MS2 = 30 * 60 * 1e3;
var CATALOG_RETRY_AFTER_FAILURE_MS2 = 60 * 1e3;
var RegionStack = class {
  constructor(region, logger, cacheRoot, endpoints, portIndex = 0) {
    this.endpoints = endpoints;
    this.portIndex = portIndex;
    this.modelsDiscoveredAt = 0;
    this.modelsReady = false;
    this.modelsPending = void 0;
    this.modelsFailedAt = 0;
    this.region = region;
    this.logger = logger;
    this.catalog = new TraeCatalog(region);
    this.identity = async () => {
      const store = this.store;
      const hint = region === "ai" ? "solo-sg" : "cn";
      try {
        const credential = await store.current();
        const candidates = store.candidates();
        return await resolveTraeIdentity(
          credential === void 0 ? [] : candidates.filter((c) => c.edition === credential.edition),
          hint
        );
      } catch {
        return resolveTraeIdentity([], hint).catch(() => void 0);
      }
    };
    this.store = new TraeCredentialStore({
      region,
      edition: "auto",
      refresh: async (credential) => refreshTraeCredential(credential, void 0, await this.device())
    });
    this.upstream = new TraeSoloUpstreamClient({
      credential: () => this.store.resolve(),
      identity: this.identity,
      log: (message, detail) => this.logger.warn(message, detail)
    });
    this.remoteCatalog = new TraeSoloRemoteCatalogClient({
      credential: () => this.store.resolve()
    });
    this.wire = { byId: /* @__PURE__ */ new Map(), byName: /* @__PURE__ */ new Map(), callableKeys: /* @__PURE__ */ new Set(), resolved: false };
    this.wireResolver = (displayId) => this.wire.byId.get(displayId) ?? this.wire.byName.get(String(displayId ?? "").trim().toLowerCase());
    const bridge = new TraeSoloBridge(this.upstream, this.catalog, this.wireResolver);
    this.delegating = new TraeDelegatingUpstreamClient(bridge);
    this.shim = void 0;
  }
  /**
   * Create the loopback shim on demand.
   *
   * Pi's extension contract forbids starting sockets in the factory, so the
   * shim is created from `session_start` (warm-up) or from
   * `auth.apiKey.resolve` on the first model request.
   */
  startShim() {
    if (this.shim !== void 0) return this.shim;
    this.shim = createTraeShim({
      catalog: this.catalog,
      client: this.delegating,
      logger: this.logger,
      // Lets a request refresh the directory, mirroring what the Pi port does
      // from `auth.apiKey.resolve()`.
      refreshCatalog: () => this.refreshCatalog(),
      // Absent on the Pi port, which keeps its original random-per-process
      // behaviour.
      ...this.endpoints === void 0 ? {} : {
        secret: this.endpoints.tokenFor(this.region),
        preferredPort: this.endpoints.preferredPortFor(this.region, this.portIndex)
      }
    });
    return this.shim;
  }
  /** Start the shim (if needed) and wait until it is listening. */
  async ensureShim() {
    const shim = this.startShim();
    await shim.ready;
    if (this.endpoints !== void 0) {
      const port = Number(new URL(shim.baseUrl()).port);
      if (Number.isInteger(port) && port > 0) this.endpoints.recordPort(this.region, port);
    }
    return shim;
  }
  /**
   * Make the region ready to serve a request: shim listening + the wire map
   * (model id → Trae `config_name`/function) discovered at least once.
   *
   * The bridge needs the wire map to translate a model id into a callable
   * `config_name`; with an empty map it would forward the display id and the
   * upstream answers `4001 param is invalid`. Discovery is cached after the
   * first success, and a failure resets the cache so the next request retries.
   */
  async ensureReady({ rediscover = false, signal } = {}) {
    const shim = await this.ensureShim();
    if ((this.modelsReady === false || rediscover) && this.modelsPending === void 0) {
      const flight = this.discoverModels(signal).then((outcome) => {
        if (outcome.models.length === 0) {
          this.modelsFailedAt = Date.now();
          this.logger?.warn?.(
            `trae: model directory unavailable for ${this.region}; keeping the previous directory`,
            outcome.failures
          );
          return false;
        }
        this.applyDirectory(outcome.models, outcome.wire);
        if (outcome.complete) {
          this.modelsDiscoveredAt = Date.now();
          this.modelsFailedAt = 0;
          this.modelsReady = true;
        } else {
          this.modelsFailedAt = Date.now();
          this.logger?.warn?.(
            `trae: model directory for ${this.region} is incomplete; serving it but retrying on the next request`,
            outcome.failures
          );
        }
        return true;
      }).catch((error) => {
        this.logger?.warn?.(`trae: model directory discovery failed for ${this.region}`, error);
        this.modelsFailedAt = Date.now();
        return false;
      }).finally(() => {
        if (this.modelsPending === flight) this.modelsPending = void 0;
      });
      this.modelsPending = flight;
    }
    if (this.modelsPending !== void 0) await this.modelsPending;
    return shim;
  }
  /**
   * Land a discovered directory: replace the catalog and the wire map together.
   *
   * Only ever called with a non-empty result, so a failed or empty discovery
   * can never clear the maps a live request depends on.
   */
  applyDirectory(models, wire) {
    this.catalog.set(deriveCatalog(sanitizeCatalog(models), /* @__PURE__ */ new Set(), {}));
    this.wire.callableKeys.clear();
    for (const model of models) {
      this.wire.callableKeys.add(model.id.trim().toLowerCase());
      this.wire.callableKeys.add(model.name.trim().toLowerCase());
    }
    this.wire.byId.clear();
    this.wire.byName.clear();
    for (const [id, target] of wire) this.wire.byId.set(id, target);
    for (const [name, target] of wire) this.wire.byName.set(name, target);
    this.wire.resolved = true;
  }
  /**
   * Re-discover the model directory when it has gone stale.
   *
   * Called once per request from the shim, the way the Pi port refreshes from
   * `auth.apiKey.resolve()`. TTL-gated, so inside the window this is a no-op and
   * costs nothing. On failure `modelsDiscoveredAt` is left alone, so the next
   * request retries — same "keep the last good directory" behaviour as the
   * Qoder side.
   *
   * `force` skips the TTL check so the panel's explicit "refresh" button can
   * pick up new models inside the 30-minute window. `signal` bounds the
   * discovery for callers that must not wait forever (activation warm-up); it
   * belongs to the flight that created the slot, never to a joiner.
   *
   * @returns the shim when a discovery ran, or `null` when this was a no-op.
   */
  async refreshCatalog({ force = false, signal } = {}) {
    if (this.modelsPending !== void 0) return this.modelsPending;
    if (!force && this.modelsReady && Date.now() - this.modelsDiscoveredAt < CATALOG_TTL_MS2) return null;
    if (!force && Date.now() - this.modelsFailedAt < CATALOG_RETRY_AFTER_FAILURE_MS2) return null;
    return this.ensureReady({ rediscover: true, signal });
  }
  /**
   * The loopback base URL when the shim is running, or a placeholder.
   *
   * The placeholder is display-only: the authoritative base URL travels with
   * `auth.apiKey.resolve`, and `ModelRuntime.prepareRequest` overwrites the
   * model's `baseUrl` from it before any request is sent.
   */
  baseUrlOrPlaceholder() {
    if (this.shim === void 0) return "http://127.0.0.1:0/v1";
    try {
      return `${this.shim.baseUrl()}/v1`;
    } catch {
      return "http://127.0.0.1:0/v1";
    }
  }
  async close() {
    if (this.shim !== void 0) await this.shim.close();
  }
  async device() {
    try {
      const identity = await this.identity();
      return { deviceId: identity.deviceId, machineId: identity.machineId };
    } catch {
      return void 0;
    }
  }
  /**
   * Fetch the live model directory and merge the two Trae sources (remote
   * skeleton + wire config names).
   *
   * Returns an outcome instead of throwing, so the caller can tell "upstream is
   * down" from "the account has no models" without either one wiping the
   * directory it already serves:
   *
   * - `models` — the merged roster, empty when nothing could be discovered.
   * - `wire` — id/name → `config_name` mappings for those models.
   * - `complete` — every directory function and both sources answered. When
   *   false, the models are still usable, but a source is missing models, so
   *   the caller keeps retrying instead of caching the gap for 30 minutes.
   * - `failures` — one short string per failed source/function, for the log.
   *
   * Nothing here mutates the live catalog or wire map: only the caller does,
   * and only on a non-empty result.
   */
  async discoverModels(signal) {
    const [remoteResult, soloResult] = await Promise.all([
      this.remoteCatalog.fetchModels(signal).then(
        (models) => ({ models, failures: [] }),
        (error) => ({ models: [], failures: [`remote: ${String(error).slice(0, 120)}`] })
      ),
      // The SOLO source exposes per-function failures alongside a partial
      // roster; `fetchModels` is the plain-array form for callers that do not
      // care. Fall back when an older extraction lacks the detailed variant.
      typeof this.upstream.fetchModelsDetailed === "function" ? this.upstream.fetchModelsDetailed(signal).then(
        (result) => ({ models: result.models, failures: result.failures ?? [] }),
        (error) => ({ models: [], failures: [`solo: ${String(error).slice(0, 120)}`] })
      ) : this.upstream.fetchModels(signal).then(
        (models) => ({ models, failures: [] }),
        (error) => ({ models: [], failures: [`solo: ${String(error).slice(0, 120)}`] })
      )
    ]);
    const failures = [...remoteResult.failures, ...soloResult.failures];
    const merged = mergeTraeModelSources(remoteResult.models, soloResult.models);
    if (merged.length === 0 && soloResult.models.length > 0) {
      failures.push("remote: unavailable; serving the SOLO roster without the remote skeleton");
      for (const model of soloResult.models) {
        merged.push({
          id: model.id,
          name: model.name,
          input: ["text"],
          ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
          ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
          ...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
          ...model.reasoning === void 0 ? {} : { reasoning: model.reasoning },
          ...model.id === "" ? {} : { wireConfigName: model.id },
          ...model.function === void 0 ? {} : { wireFunction: model.function }
        });
      }
    }
    const wire = /* @__PURE__ */ new Map();
    for (const model of merged) {
      if (model.wireConfigName !== void 0) {
        wire.set(model.id, {
          configName: model.wireConfigName,
          ...model.wireFunction === void 0 ? {} : { function: model.wireFunction }
        });
      }
    }
    return {
      models: merged,
      wire,
      complete: failures.length === 0,
      failures
    };
  }
};
async function createTraeStacks({ cacheRoot, logger, endpoints }) {
  if (cacheRoot !== void 0) setTraeOwnDir(cacheRoot);
  const stacks = [];
  for (const [index, region] of REGION_KEYS.entries()) {
    const stack = new RegionStack(region, logger, cacheRoot, endpoints, index);
    stack.catalog.set(fallbackModelsFor(region));
    stacks.push(stack);
  }
  return stacks;
}

// src/qoder/ops.js
var REGION_LABEL = { "qoder-cn": "Qoder CN\uFF08\u56FD\u5185\u7248\uFF09", qoder: "Qoder\uFF08\u56FD\u9645\u7248\uFF09" };
var TIMEOUT_MS = 2e4;
function qoderRegionLabel(regionId) {
  return REGION_LABEL[regionId] ?? regionId;
}
function accountLabel(credential) {
  return credential?.name || credential?.email || credential?.userID || "\u672C\u673A\u767B\u5F55";
}
function usageLines(usage) {
  if (usage === void 0) return ["\u65E0\u53EF\u7528\u989D\u5EA6\u6570\u636E\uFF08\u8BE5\u8D26\u53F7\u989D\u5EA6\u4E3A 0 \u6216\u672A\u5F00\u901A\uFF09"];
  const lines = [];
  const bucket = (name, b) => {
    if (b === void 0) return;
    const unit = b.unit === "credits" ? "" : ` ${b.unit}`;
    lines.push(`${name}\uFF1A\u5269\u4F59 ${b.remaining} / ${b.total}${unit}\uFF08${Math.round(b.percentage * 100)}%\uFF09`);
  };
  bucket("\u4E3B\u989D\u5EA6", usage.userQuota);
  bucket("\u9644\u52A0\u989D\u5EA6", usage.addOnQuota);
  for (const pkg of usage.dedicatedPackages ?? []) {
    lines.push(`${pkg.name ? `${pkg.name} ` : ""}\u5269\u4F59 ${pkg.remaining}/${pkg.total}`);
  }
  if (usage.isQuotaExceeded) lines.push("\u26A0 \u989D\u5EA6\u5DF2\u7528\u5C3D");
  const checkin = usage.checkin;
  if (checkin === void 0) lines.push("\u7B7E\u5230\uFF1A\u72B6\u6001\u4E0D\u53EF\u8BFB");
  else if (!checkin.active) lines.push("\u7B7E\u5230\uFF1A\u4ECA\u65E5\u65E0\u8FDB\u884C\u4E2D\u7684\u6D3B\u52A8");
  else lines.push(`\u7B7E\u5230\uFF1A${checkin.todayCheckedIn ? "\u4ECA\u65E5\u5DF2\u9886\u53D6" : "\u4ECA\u65E5\u53EF\u9886\u53D6"}${checkin.amount === void 0 ? "" : `\uFF08${checkin.amount} ${checkin.unit ?? "\u79EF\u5206"}\uFF09`}`);
  for (const campaign of usage.campaigns ?? []) {
    if (campaign.title) lines.push(`\xB7 ${campaign.title}${campaign.description ? ` \u2014 ${campaign.description}` : ""}`);
  }
  return lines.length > 0 ? lines : ["\u65E0\u53EF\u663E\u793A\u6570\u636E"];
}
async function qoderUsage(runtimes, signal) {
  const out = [];
  for (const runtime of runtimes) {
    const regionId = runtime.region.id;
    const label = qoderRegionLabel(regionId);
    try {
      const credential = await runtime.resolveCredential();
      if (credential === void 0) {
        out.push({ regionId, label, ok: false, status: "\u672A\u767B\u5F55", lines: [] });
        continue;
      }
      const usage = await fetchUsage(runtime.region, credential, signal ?? AbortSignal.timeout(TIMEOUT_MS));
      out.push({ regionId, label, ok: true, account: accountLabel(credential), lines: usageLines(usage) });
    } catch (error) {
      out.push({ regionId, label, ok: false, status: `\u8BFB\u53D6\u5931\u8D25\uFF1A${error?.message ?? error}`, lines: [] });
    }
  }
  return out;
}
async function qoderCheckin(runtimes, signal) {
  const out = [];
  for (const runtime of runtimes) {
    const regionId = runtime.region.id;
    const label = qoderRegionLabel(regionId);
    try {
      const credential = await runtime.resolveCredential();
      if (credential === void 0) {
        out.push({ regionId, label, status: "skipped", message: "\u672A\u767B\u5F55" });
        continue;
      }
      const payload = await readCampaigns(runtime.region, credential, signal ?? AbortSignal.timeout(TIMEOUT_MS));
      const campaign = claimableCampaignOf(payload);
      if (campaign === void 0) {
        out.push({ regionId, label, status: "none", message: "\u4ECA\u65E5\u65E0\u8FDB\u884C\u4E2D\u7684\u7B7E\u5230\u6D3B\u52A8" });
        continue;
      }
      if (campaignIsClaimed(campaign)) {
        const amount = benefitOf(campaign)?.amount;
        out.push({ regionId, label, status: "already", message: `\u4ECA\u65E5\u5DF2\u9886\u53D6${amount === void 0 ? "" : `\uFF08${amount} \u79EF\u5206\uFF09`}` });
        continue;
      }
      const campaignId = String(campaign.campaignKey ?? campaign.campaignId ?? "");
      const result = await claimCampaign(runtime.region, credential, campaignId, signal ?? AbortSignal.timeout(TIMEOUT_MS));
      const normalized = normalizeClaimResult(result, campaign);
      if (normalized.claimed && !normalized.replayed) {
        out.push({ regionId, label, status: "claimed", message: `\u7B7E\u5230\u6210\u529F${normalized.amount === void 0 ? "" : `\uFF0C\u83B7\u5F97 ${normalized.amount} \u79EF\u5206`}` });
      } else if (normalized.replayed) {
        out.push({ regionId, label, status: "already", message: "\u4ECA\u65E5\u5DF2\u9886\u53D6\u8FC7\uFF08\u4E0A\u6E38\u672A\u91CD\u590D\u53D1\u653E\uFF09" });
      } else {
        out.push({ regionId, label, status: "error", message: "\u7B7E\u5230\u672A\u6210\u529F" });
      }
    } catch (error) {
      out.push({ regionId, label, status: "error", message: `\u7B7E\u5230\u5931\u8D25\uFF1A${error?.message ?? error}` });
    }
  }
  return out;
}

// src/trae/ops.js
var REGION_LABEL2 = { cn: "Trae CN\uFF08\u56FD\u5185\u7248\uFF09", ai: "Trae Global\uFF08\u56FD\u9645\u7248\uFF09" };
function traeRegionLabel(region) {
  return REGION_LABEL2[region] ?? region;
}
function clientFor(stack) {
  return new TraeUsageClient({
    credential: () => stack.store.resolve(),
    deviceId: () => stack.device().then((d) => d?.deviceId)
  });
}
function creditLines(credits) {
  const lines = [`\u603B\u989D\u5EA6 ${credits.total} / \u5DF2\u7528 ${credits.consumed} / \u53EF\u7528 ${credits.available}`];
  for (const pack of credits.accounts) {
    lines.push(`\xB7 ${pack.displayDesc || "\u989D\u5EA6\u5305"}\uFF1A\u5269\u4F59 ${pack.remain} / ${pack.size}`);
  }
  return lines;
}
function checkinLines(checkin) {
  const parts = [checkin.checkedIn ? "\u4ECA\u65E5\u5DF2\u9886\u53D6" : "\u4ECA\u65E5\u53EF\u9886\u53D6"];
  if (checkin.didCheckedIn) parts.push("\u672C\u8BBE\u5907\u4ECA\u65E5\u5DF2\u7B7E\u5230");
  if (checkin.credits !== void 0) parts.push(`\u5956\u52B1 ${checkin.credits} \u79EF\u5206`);
  if (checkin.extraCredits !== void 0) parts.push(`\u989D\u5916 ${checkin.extraCredits}`);
  if (checkin.enabled === false) parts.push("\uFF08\u8BE5\u8D26\u53F7\u672A\u5F00\u901A\u7B7E\u5230\uFF09");
  return [parts.join(" | ")];
}
async function traeUsage(stacks) {
  const out = [];
  for (const stack of stacks) {
    const regionId = stack.region;
    const label = traeRegionLabel(regionId);
    try {
      const credential = await stack.store.resolve();
      if (credential === void 0) {
        out.push({ regionId, label, ok: false, status: "\u672A\u767B\u5F55", lines: [] });
        continue;
      }
      const client = clientFor(stack);
      const current = await client.currentRegion();
      if (current === "ai") {
        const pay = await client.payStatus();
        const bits = [`\u8BA2\u9605\u8BA1\u8D39\uFF1A${pay.isDollarUsageBilling ? "\u662F" : "\u5426"}`];
        if (pay.hasPackage) bits.push("\u5DF2\u8D2D\u5957\u9910");
        if (pay.inTrial) bits.push(`\u8BD5\u7528\u4E2D\uFF08\u81F3 ${new Date(pay.trialEndTimeMs).toLocaleDateString()}\uFF09`);
        if (pay.fission) bits.push(`\u88C2\u53D8\u989D\u5EA6 ${pay.fission.maxUsage}`);
        out.push({ regionId, label, ok: true, account: credential.accountName ?? credential.userId, lines: [bits.join(" | ")] });
        continue;
      }
      const snapshot = await client.snapshot();
      const checkin = await client.checkinStatus();
      out.push({
        regionId,
        label,
        ok: true,
        account: credential.accountName ?? credential.userId,
        lines: [...creditLines(toCredits(snapshot)), ...checkinLines(toCheckin(checkin))]
      });
    } catch (error) {
      out.push({ regionId, label, ok: false, status: `\u8BFB\u53D6\u5931\u8D25\uFF1A${safeMessage(error)}`, lines: [] });
    }
  }
  return out;
}
async function traeCheckin(stacks) {
  const out = [];
  for (const stack of stacks) {
    const regionId = stack.region;
    const label = traeRegionLabel(regionId);
    let client;
    let current;
    try {
      client = clientFor(stack);
      current = await client.checkinStatus();
    } catch (error) {
      out.push({ regionId, label, status: "error", message: `\u7B7E\u5230\u72B6\u6001\u8BFB\u53D6\u5931\u8D25\uFF1A${safeMessage(error)}` });
      continue;
    }
    if (!current.enabled) {
      out.push({ regionId, label, status: "none", message: "\u8BE5\u8D26\u53F7\u672A\u5F00\u901A\u7B7E\u5230" });
      continue;
    }
    if (current.checkedIn) {
      out.push({ regionId, label, status: "already", message: `\u4ECA\u65E5\u5DF2\u9886\u53D6${current.credits === void 0 ? "" : `\uFF08${current.credits} \u79EF\u5206\uFF09`}` });
      continue;
    }
    if (current.didCheckedIn) {
      out.push({ regionId, label, status: "already", message: "\u672C\u8BBE\u5907\u4ECA\u65E5\u5DF2\u7B7E\u5230\uFF08\u53EF\u80FD\u7528\u7684\u662F\u53E6\u4E00\u4E2A\u8D26\u53F7\uFF09" });
      continue;
    }
    try {
      const claim = await client.claimCheckin();
      if (claim.code === CHECKIN_DEVICE_ALREADY_CLAIMED) {
        out.push({ regionId, label, status: "already", message: "\u672C\u8BBE\u5907\u4ECA\u65E5\u5DF2\u7B7E\u5230\uFF08\u4E0A\u6E38\u5DF2\u62D2\u7EDD\u91CD\u590D\u9886\u53D6\uFF09" });
        continue;
      }
      if (claim.claimed) {
        const after = await client.checkinStatus();
        out.push({ regionId, label, status: "claimed", message: `\u7B7E\u5230\u6210\u529F\uFF1A${checkinLines(toCheckin(after)).join(" | ")}` });
      } else {
        out.push({ regionId, label, status: "error", message: `\u7B7E\u5230\u672A\u6210\u529F\uFF1A${claim.message ?? `code ${claim.code ?? "?"}`}` });
      }
    } catch (error) {
      out.push({ regionId, label, status: "error", message: `\u7B7E\u5230\u5931\u8D25\uFF1A${safeMessage(error)}` });
    }
  }
  return out;
}

// src/entry.js
var PLUGIN_ID = "ide-account-bridge";
var IPC = {
  STATE: "state",
  REFRESH: "refresh",
  USAGE: "usage",
  CHECKIN: "checkin"
};
var WARM_TIMEOUT_MS = 3e4;
var WINDOW_WIDTH = 780;
var WINDOW_HEIGHT = 640;
var REGION_LABEL3 = {
  "qoder-cn": "Qoder CN\uFF08\u56FD\u5185\u7248\uFF09",
  qoder: "Qoder\uFF08\u56FD\u9645\u7248\uFF09",
  cn: "Trae CN\uFF08\u56FD\u5185\u7248\uFF09",
  ai: "Trae Global\uFF08\u56FD\u9645\u7248\uFF09"
};
function makeLogger(ctx) {
  const prefix = `[${PLUGIN_ID}]`;
  return {
    info: (message) => ctx.log(`${prefix} ${message}`),
    warn: (message, detail) => ctx.log(`${prefix} WARN ${message}`, detail ?? ""),
    error: (message, detail) => ctx.log(`${prefix} ERROR ${message}`, detail ?? "")
  };
}
function qoderRegionState(runtime) {
  const regionId = runtime.region.id;
  return {
    group: "qoder",
    regionId,
    label: REGION_LABEL3[regionId] ?? regionId,
    ready: runtime.shim !== void 0,
    baseUrl: runtime.baseUrlOrPlaceholder(),
    token: runtime.shim?.token?.() ?? null,
    models: runtime.catalog.current().map((entry) => ({ id: entry.id, name: entry.name }))
  };
}
function traeRegionState(stack) {
  const regionId = stack.region;
  return {
    group: "trae",
    regionId,
    label: REGION_LABEL3[regionId] ?? regionId,
    ready: stack.shim !== void 0,
    baseUrl: stack.baseUrlOrPlaceholder(),
    token: stack.shim?.token?.() ?? null,
    models: stack.catalog.current().map((entry) => ({ id: entry.id, name: entry.name }))
  };
}
function createWindowManager(logger) {
  let win = null;
  const close = () => {
    const target = win;
    win = null;
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.close();
    } catch (error) {
      logger.warn("\u5173\u95ED\u9762\u677F\u7A97\u53E3\u5931\u8D25", error instanceof Error ? error.message : String(error));
    }
  };
  const open = async (ctx) => {
    if (ctx.signal.aborted) return;
    ctx.signal.addEventListener("abort", close, { once: true });
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (error) {
        logger.warn("\u805A\u7126\u9762\u677F\u7A97\u53E3\u5931\u8D25", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    win = null;
    try {
      const electron = require("electron");
      const created = new electron.BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        minWidth: 620,
        minHeight: 480,
        title: "IDE \u8D26\u53F7\u6865\u63A5",
        autoHideMenuBar: true,
        backgroundColor: "#f4f6fb",
        // The panel is a trusted static page shipped inside the plugin and
        // talks to the plugin through ipcRenderer directly.
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      created.webContents.on("will-navigate", (event) => event.preventDefault());
      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.on("closed", () => {
        if (win === created) win = null;
      });
      win = created;
      await created.loadFile((0, import_node_path7.join)(__dirname, "panel", "index.html"));
      if (ctx.signal.aborted) close();
    } catch (error) {
      logger.warn("\u6253\u5F00\u9762\u677F\u7A97\u53E3\u5931\u8D25", error instanceof Error ? error.message : String(error));
      close();
    }
  };
  return { open, close };
}
var activeCtx = null;
var winManagerRef = null;
var plugin = {
  async register(ctx) {
    const logger = makeLogger(ctx);
    const cacheRoot = ctx.storage.rootDir();
    let qoderRuntimes = [];
    let traeStacks = [];
    let winManager = null;
    const endpoints = createEndpointStore({ path: (0, import_node_path7.join)(cacheRoot, "endpoints.json"), logger });
    try {
      qoderRuntimes = await createQoderRuntimes({ cacheRoot: (0, import_node_path7.join)(cacheRoot, "qoder"), logger, endpoints });
    } catch (error) {
      logger.error("Qoder \u8FD0\u884C\u65F6\u521D\u59CB\u5316\u5931\u8D25", error instanceof Error ? error.message : String(error));
    }
    try {
      traeStacks = await createTraeStacks({ cacheRoot: (0, import_node_path7.join)(cacheRoot, "trae"), logger, endpoints });
    } catch (error) {
      logger.error("Trae \u8FD0\u884C\u65F6\u521D\u59CB\u5316\u5931\u8D25", error instanceof Error ? error.message : String(error));
    }
    const deadline = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(WARM_TIMEOUT_MS)]);
    let warmPromise = Promise.resolve();
    const startWarm = (force = false) => {
      warmPromise = (async () => {
        for (const runtime of qoderRuntimes) {
          try {
            const credential = await runtime.resolveCredential();
            if (!isCredentialUsable(credential)) continue;
            await runtime.refreshCatalog(deadline(), { force });
            await runtime.ensureShim();
          } catch (error) {
            logger.warn(`qoder ${runtime.region.id}: \u9884\u70ED\u5931\u8D25`, error instanceof Error ? error.message : String(error));
          }
        }
        for (const stack of traeStacks) {
          try {
            const credential = await stack.store.resolve().catch(() => void 0);
            if (credential === void 0) continue;
            await stack.ensureShim();
            await stack.refreshCatalog({ force, signal: deadline() });
          } catch (error) {
            logger.warn(`trae ${stack.region}: \u9884\u70ED\u5931\u8D25`, error instanceof Error ? error.message : String(error));
          }
        }
      })();
      return warmPromise;
    };
    startWarm();
    const readState = () => ({
      pluginId: PLUGIN_ID,
      regions: [...qoderRuntimes.map(qoderRegionState), ...traeStacks.map(traeRegionState)]
    });
    let checkinInFlight = null;
    const runCheckin = () => {
      if (checkinInFlight !== null) return checkinInFlight;
      checkinInFlight = (async () => ({
        qoder: await qoderCheckin(qoderRuntimes, deadline()),
        trae: await traeCheckin(traeStacks)
      }))().finally(() => {
        checkinInFlight = null;
      });
      return checkinInFlight;
    };
    ctx.registerIpc(IPC.STATE, async () => {
      await warmPromise;
      return readState();
    });
    ctx.registerIpc(IPC.REFRESH, async () => {
      await startWarm(true);
      return readState();
    });
    ctx.registerIpc(IPC.USAGE, async () => ({
      qoder: await qoderUsage(qoderRuntimes, ctx.signal),
      trae: await traeUsage(traeStacks)
    }));
    ctx.registerIpc(IPC.CHECKIN, () => runCheckin());
    ctx.registerTool({
      id: `${PLUGIN_ID}_usage`,
      name: "\u67E5\u8BE2 IDE \u8D26\u53F7\u989D\u5EA6",
      description: "\u8BFB\u53D6\u672C\u673A\u5DF2\u767B\u5F55\u7684 Qoder \u4E0E Trae \u8D26\u53F7\u7684\u989D\u5EA6\u3001\u4FC3\u9500\u6D3B\u52A8\u4E0E\u4ECA\u65E5\u7B7E\u5230\u72B6\u6001\u3002\u53EA\u8BFB\u64CD\u4F5C\uFF0C\u4E0D\u4F1A\u6539\u52A8\u4EFB\u4F55\u8D26\u53F7\u72B6\u6001\u3002\u8BFB\u53D6 Qoder \u51ED\u636E\u65F6\u4F1A\u542F\u52A8\u5B50\u8FDB\u7A0B\uFF08\u7CFB\u7EDF DPAPI \u89E3\u5BC6\u3001\u4EE5\u53CA Qoder \u5B89\u88C5\u76EE\u5F55\u4E0B\u7684 runtime-info.exe\uFF09\uFF0C\u5E76\u8BBF\u95EE\u5BF9\u5E94\u5382\u5546\u7684\u63A5\u53E3\u3002",
      category: "provider",
      // `shell`, not `network`: reading a Qoder credential spawns PowerShell for
      // the DPAPI unwrap and the vendor's own runtime-info.exe, so the approval
      // prompt must describe a subprocess rather than a plain request. `risk` is
      // a single value, so the network access is stated in the description.
      risk: "shell",
      effectKind: "read",
      verificationPolicy: "none",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const [qoder, trae] = [await qoderUsage(qoderRuntimes, void 0), await traeUsage(traeStacks)];
        const render = (rows) => rows.map((row) => `${row.label}${row.ok ? `\uFF08${row.account ?? ""}\uFF09` : ""}\uFF1A
  ${(row.lines.length > 0 ? row.lines : [row.status ?? "\u65E0\u6570\u636E"]).join("\n  ")}`).join("\n\n");
        return `Qoder:

${render(qoder)}

Trae:

${render(trae)}`;
      }
    });
    ctx.registerTool({
      id: `${PLUGIN_ID}_models`,
      name: "\u5217\u51FA IDE \u8D26\u53F7\u53EF\u7528\u6A21\u578B",
      description: "\u5217\u51FA\u5404\u533A\u57DF\u901A\u8FC7\u672C\u63D2\u4EF6\u66B4\u9732\u7684\u6A21\u578B ID\u3002\u8FD9\u4E9B ID \u7528\u4E8E\u5728 Cyrene \u7684\u6A21\u578B\u6863\u6848\u91CC\u586B\u5199\uFF0C\u914D\u5408\u9762\u677F\u7ED9\u51FA\u7684 Base URL \u4E0E token \u4F7F\u7528\u3002",
      category: "provider",
      risk: "safe",
      effectKind: "read",
      verificationPolicy: "none",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const state = readState();
        return state.regions.map((region) => {
          if (!region.ready) return `${region.label}\uFF1A\u672A\u767B\u5F55`;
          const ids = region.models.map((m) => m.id).join(", ");
          return `${region.label}\uFF1A${region.models.length} \u4E2A\u6A21\u578B
  Base URL ${region.baseUrl}
  ${ids}`;
        }).join("\n\n");
      }
    });
    ctx.registerTool({
      id: `${PLUGIN_ID}_checkin`,
      name: "\u9886\u53D6 IDE \u8D26\u53F7\u6BCF\u65E5\u7B7E\u5230\u989D\u5EA6",
      description: "\u5411\u672C\u673A\u5DF2\u767B\u5F55\u7684 Qoder / Trae \u8D26\u53F7\u9886\u53D6\u4ECA\u65E5\u7B7E\u5230\u989D\u5EA6\u3002\u8FD9\u662F\u672C\u63D2\u4EF6\u552F\u4E00\u4F1A\u6539\u52A8\u8D26\u53F7\u72B6\u6001\u7684\u64CD\u4F5C\uFF0C\u4F1A\u5148\u8BFB\u53D6\u72B6\u6001\uFF0C\u5DF2\u9886\u53D6\u8FC7\u7684\u4E0D\u4F1A\u91CD\u590D\u8BF7\u6C42\u3002\u5FC5\u987B\u663E\u5F0F\u4F20\u5165 confirm=true \u624D\u4F1A\u6267\u884C\u3002\u8BFB\u53D6 Qoder \u51ED\u636E\u65F6\u4F1A\u542F\u52A8\u5B50\u8FDB\u7A0B\uFF08\u7CFB\u7EDF DPAPI \u89E3\u5BC6\u3001\u4EE5\u53CA Qoder \u5B89\u88C5\u76EE\u5F55\u4E0B\u7684 runtime-info.exe\uFF09\uFF0C\u5E76\u8BBF\u95EE\u5BF9\u5E94\u5382\u5546\u7684\u63A5\u53E3\u3002",
      category: "provider",
      // Changes state on the upstream account, and reaches it through the same
      // subprocess-spawning credential path as `_usage`, so it is declared
      // `shell` rather than `network`. See the note on `_usage`.
      risk: "shell",
      effectKind: "external_side_effect",
      verificationPolicy: "none",
      enabled: true,
      inputSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "\u5FC5\u987B\u4E3A true \u624D\u771F\u6B63\u6267\u884C\u9886\u53D6\uFF1B\u7F3A\u7701\u6216 false \u65F6\u53EA\u56DE\u62A5\u5C06\u8981\u6267\u884C\u7684\u52A8\u4F5C\u3002"
          }
        },
        required: ["confirm"]
      },
      async execute(args) {
        if (args.confirm !== true) {
          return "\u672A\u6267\u884C\uFF1A\u9886\u53D6\u7B7E\u5230\u4F1A\u6539\u52A8\u8D26\u53F7\u72B6\u6001\uFF0C\u9700\u8981 confirm=true \u660E\u786E\u786E\u8BA4\u3002";
        }
        const result = await runCheckin();
        return [...result.qoder, ...result.trae].map((row) => `${row.label}\uFF1A${row.message}`).join("\n");
      }
    });
    winManager = createWindowManager(logger);
    activeCtx = ctx;
    winManagerRef = winManager;
    ctx.onDispose(async () => {
      activeCtx = null;
      winManagerRef = null;
      winManager?.close();
      winManager = null;
      for (const runtime of qoderRuntimes) {
        try {
          await runtime.close();
        } catch (error) {
          logger.warn(`qoder ${runtime.region.id}: \u5173\u95ED shim \u5931\u8D25`, error instanceof Error ? error.message : String(error));
        }
      }
      for (const stack of traeStacks) {
        try {
          await stack.close();
        } catch (error) {
          logger.warn(`trae ${stack.region}: \u5173\u95ED shim \u5931\u8D25`, error instanceof Error ? error.message : String(error));
        }
      }
      qoderRuntimes = [];
      traeStacks = [];
    });
    warmPromise.then(() => {
      const ready = readState().regions.filter((r) => r.ready).map((r) => r.regionId);
      logger.info(`\u5DF2\u542F\u7528\uFF1A${ready.join(", ") || "\u672C\u673A\u6CA1\u6709\u5DF2\u767B\u5F55\u7684 Qoder / Trae \u8D26\u53F7"}`);
    });
  },
  async unregister() {
  },
  async open() {
    if (activeCtx === null || winManagerRef === null) return;
    await winManagerRef.open(activeCtx);
  }
};
var entry_default = plugin;
var __p = module.exports.default; module.exports = __p; module.exports.default = __p;

// Windows W1 display provider (3.1 virtual-gui).
//
// The bundled helper owns the private WinSta0 desktop and the Blender process
// (CREATE_SUSPENDED + lpDesktop + a kill-on-close job object). This module is
// the only place the Gateway talks that protocol: it starts one helper per
// session, parses the ready/error line, keeps the relayed stdout/stderr tail,
// and fails closed with a structured provider error. It never retries on the
// default desktop: a helper that cannot create the private desktop is an error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CFG } from '../config.js';
import { DisplayProviderError } from './errors.js';
import { isHelperFile, resolveHiddenDesktopHelper } from './helper-path.js';
import { buildDisplayCapabilities } from './prerequisites.js';
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_LINES = 80;
const HELPER_FIX = 'install a 3.1 build that ships vendor/win-hidden-desktop/dsh-blender-hidden-desktop.exe, or set DSH_HIDDEN_DESKTOP_HELPER to its path';
const BLENDER_FIX = 'set DSH_BLENDER_EXE or install Blender 4.2.10 LTS';
const SELF_TEST_FIX = 'run the helper manually with --self-test and inspect its error event (code + win32 field)';
function pushTail(lines, line) {
    lines.push(line);
    if (lines.length > LOG_LINES)
        lines.shift();
}
function parseHelperEvent(line) {
    const text = line.trim();
    if (!text.startsWith('{'))
        return null;
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        const event = value.event;
        return event === 'ready' || event === 'error' ? value : null;
    }
    catch (e) {
        return null;
    }
}
function pidOf(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}
function attachLines(child, onLine) {
    const detach = [];
    const bind = (stream, name) => {
        if (!stream)
            return;
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk.toString();
            let index = buffer.indexOf('\n');
            while (index >= 0) {
                onLine(buffer.slice(0, index), name);
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
            }
        };
        stream.on('data', onData);
        detach.push(() => stream.removeListener('data', onData));
    };
    bind(child.stdout, 'stdout');
    bind(child.stderr, 'stderr');
    return () => {
        for (const fn of detach)
            fn();
    };
}
function desktopName(sessionId, counter) {
    const clean = String(sessionId || 'session')
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .slice(0, 96) || 'session';
    return 'dsh-vgui-' + clean + '-' + counter + '-' + process.pid;
}
function runnableFile(file) {
    try {
        return fs.statSync(file).isFile();
    }
    catch (e) {
        return false;
    }
}
/** One helper-created hidden desktop; the Windows implementation of DisplayProvider. */
export class WinHiddenDesktopProvider {
    kind = 'win-hidden-desktop';
    options;
    records = new Map();
    counter = 0;
    constructor(options = {}) {
        this.options = options;
    }
    capabilities() {
        return buildDisplayCapabilities({
            platform: 'win32',
            configured: CFG.features.virtualGui,
            source: CFG.features.source,
            env: this.options.env,
            providerImplemented: true,
            blenderExe: this.options.blenderExe,
        });
    }
    /** Resolve first, so start fails before spawning when the helper is absent. */
    resolveHelper() {
        const explicit = this.options.helperPath;
        if (explicit === undefined) {
            return resolveHiddenDesktopHelper({ env: this.options.env });
        }
        if (!explicit) {
            return { path: null, source: 'option', checked: [], detail: 'no helper path configured' };
        }
        if (!isHelperFile(explicit)) {
            return {
                path: null,
                source: 'option',
                checked: [explicit],
                detail: 'configured helper path is not a file: ' + explicit,
            };
        }
        return { path: explicit, source: 'option', checked: [explicit], detail: explicit + ' (option)' };
    }
    commandSpec(request) {
        if (!this.options.spawnImpl && process.platform !== 'win32') {
            throw new DisplayProviderError('config', 'unsupported_platform', 'the Windows hidden-desktop provider can only run on Windows (platform=' +
                process.platform +
                ')', 'virtual-gui is Windows-only in 3.1; use user-gui or headless render');
        }
        const helper = this.resolveHelper();
        if (!helper.path) {
            throw new DisplayProviderError('config', 'helper_missing', helper.detail, HELPER_FIX, {
                checked: helper.checked,
            });
        }
        const blender = String(this.options.blenderExe || CFG.blenderExe || '');
        if (!blender || !runnableFile(blender)) {
            throw new DisplayProviderError('config', 'blender_exe_missing', blender
                ? 'blender executable does not exist: ' + blender
                : 'blender executable not configured', BLENDER_FIX, { blenderExe: blender || null, source: CFG.source.blenderExe });
        }
        const desktop = desktopName(request.sessionId, this.counter + 1);
        const args = ['--exe', blender, '--desktop', desktop, '--parent-pid', String(process.pid)];
        if (this.options.workDir)
            args.push('--cwd', this.options.workDir);
        args.push('--', ...(Array.isArray(request.blenderArgs) ? request.blenderArgs.map(String) : []));
        return {
            command: helper.path,
            args,
            options: {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: this.spawnEnv(request),
            },
        };
    }
    /** Blender inherits these: the addon dials this Gateway and reuses the expected identity. */
    spawnEnv(request) {
        const env = { ...process.env, ...(this.options.env || {}) };
        env.DSHBB_GATEWAY_PORT = String(CFG.gatewayPort);
        // The add-on reports this in its handshake: a provider-launched Blender is a
        // virtual-gui instance, not a window the human opened.
        env.DSHBB_SESSION_KIND = 'virtual-gui';
        if (request.instanceId)
            env.DSHBB_INSTANCE_ID = String(request.instanceId);
        return env;
    }
    onReadyLine(state, line, stream, finish) {
        if (!line)
            return;
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (stream === 'stdout')
            pushTail(state.stdout, text);
        else
            pushTail(state.stderr, text);
        this.options.onOutput?.(text, stream);
        // After ready the same listener keeps relaying into the record tail;
        // only the ready/error parsing stops.
        if (state.settled || stream !== 'stdout')
            return;
        const event = parseHelperEvent(text);
        if (!event)
            return;
        if (event.event === 'ready') {
            // Keep the live arrays: the same listener keeps appending relayed
            // output to them after the promise resolves.
            finish(null, {
                display: String(event.display || ''),
                blenderPid: pidOf(event.blender),
                stdout: state.stdout,
                stderr: state.stderr,
            });
            return;
        }
        finish(new DisplayProviderError(String(event.stage || 'spawn'), String(event.code || 'helper_error'), String(event.message || 'the hidden-desktop helper failed'), SELF_TEST_FIX, {
            win32: event.win32 === undefined ? null : event.win32,
            stdout: state.stdout.slice(),
            stderr: state.stderr.slice(),
        }));
    }
    waitForReady(child) {
        const timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const state = { stdout: [], stderr: [], settled: false };
            let timer = null;
            let detach = () => { };
            const finish = (failure, info) => {
                if (state.settled)
                    return;
                state.settled = true;
                if (timer)
                    clearTimeout(timer);
                if (failure) {
                    detach();
                    child.removeListener('exit', onExit);
                    child.removeListener('error', onError);
                    reject(failure);
                    return;
                }
                if (info)
                    resolve(info);
            };
            const onExit = (code) => {
                finish(new DisplayProviderError('spawn', 'helper_exited', 'the hidden-desktop helper exited before its ready event (exit ' + code + ')', SELF_TEST_FIX, { exitCode: code, stdout: state.stdout.slice(), stderr: state.stderr.slice() }));
            };
            const onError = (error) => {
                finish(new DisplayProviderError('config', 'helper_spawn_failed', 'cannot start the hidden-desktop helper: ' + error.message, HELPER_FIX, {}));
            };
            detach = attachLines(child, (line, stream) => this.onReadyLine(state, line, stream, finish));
            child.once('exit', onExit);
            child.once('error', onError);
            timer = setTimeout(() => {
                finish(new DisplayProviderError('spawn', 'provider_timeout', 'the hidden-desktop helper did not report ready within ' + timeoutMs + 'ms', SELF_TEST_FIX, { timeoutMs, stdout: state.stdout.slice(), stderr: state.stderr.slice() }));
            }, timeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
        });
    }
    async start(request) {
        const spec = this.commandSpec(request);
        const spawnFn = this.options.spawnImpl || ((command, args, options) => spawn(command, args, options));
        const child = spawnFn(spec.command, spec.args, spec.options);
        let ready;
        try {
            ready = await this.waitForReady(child);
        }
        catch (error) {
            this.terminate(child);
            throw error;
        }
        const id = 'display_' + ++this.counter;
        const handle = {
            id,
            display: ready.display,
            pid: ready.blenderPid,
            provider: this.kind,
        };
        const record = {
            handle,
            child,
            desktop: ready.display,
            blenderPid: ready.blenderPid,
            stdout: ready.stdout,
            stderr: ready.stderr,
            exitCode: null,
            startedAt: Date.now(),
        };
        this.records.set(id, record);
        child.once('exit', (code) => {
            record.exitCode = code;
            this.options.onExit?.(handle, code);
        });
        return handle;
    }
    terminate(child) {
        try {
            if (child.exitCode === null)
                child.kill();
        }
        catch (e) {
            /* already gone */
        }
    }
    waitExit(child, timeoutMs) {
        if (child.exitCode !== null)
            return Promise.resolve(true);
        return new Promise((resolve) => {
            let timer = null;
            const onExit = () => done(true);
            const done = (value) => {
                if (timer)
                    clearTimeout(timer);
                child.removeListener('exit', onExit);
                resolve(value);
            };
            child.once('exit', onExit);
            timer = setTimeout(() => done(child.exitCode !== null), timeoutMs);
            if (typeof timer.unref === 'function')
                timer.unref();
        });
    }
    killTree(child) {
        const pid = child.pid;
        if (!pid)
            return;
        try {
            if (process.platform === 'win32') {
                const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.on('error', () => { });
                return;
            }
            process.kill(-pid, 'SIGKILL');
        }
        catch (e) {
            try {
                child.kill('SIGKILL');
            }
            catch (ignored) {
                /* already gone */
            }
        }
    }
    /** Release the helper and therefore Blender (job object kill-on-close). */
    async stop(instance) {
        const record = this.records.get(instance.id);
        if (!record)
            return;
        this.records.delete(instance.id);
        this.terminate(record.child);
        const exited = await this.waitExit(record.child, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
        if (!exited)
            this.killTree(record.child);
    }
    async health(instance) {
        const record = this.records.get(instance.id);
        if (!record) {
            return { ok: false, detail: 'display handle is not owned by this Gateway (already stopped)' };
        }
        if (record.exitCode !== null) {
            return { ok: false, detail: 'hidden-desktop helper exited with code ' + record.exitCode };
        }
        return {
            ok: true,
            detail: 'helper pid=' +
                String(record.child.pid || '?') +
                ' blender pid=' +
                String(record.blenderPid || '?') +
                ' desktop=' +
                record.desktop,
        };
    }
    /** Relay tail for diagnostics; null when the handle was never owned here. */
    output(instance) {
        const record = this.records.get(instance.id);
        if (!record)
            return null;
        return {
            stdout: record.stdout.slice(),
            stderr: record.stderr.slice(),
            exitCode: record.exitCode,
            startedAt: record.startedAt,
        };
    }
}
//# sourceMappingURL=win-hidden-desktop.js.map
// 热无头 worker 会话池入口（拆分）
import { CFG } from '../../config.js';
import { errorMessage } from '../../core/json.js';
import { workerAlive, workerCall, workerList, workerSnapshot, workerState } from './api.js';
import { workerStart } from './worker-start.js';
import { createWorkerReaper, workerRestart, workerStop } from './lifecycle.js';
export function createWorkersApi(E) {
    const ctx = {
        metrics: E.metrics,
        preloadChunk: E.preloadChunk,
        WORKERS: new Map(),
        WORKER_PORT: Number(process.env.DSH_BLENDER_WORKER_PORT) || CFG.workerPort || 9879,
    };
    const { metrics } = ctx;
    const start = (opts = {}, nameArg) => workerStart(ctx, opts, nameArg);
    async function workerExec(code, timeoutMs = 120000, purgePrefixes = null, nameArg) {
        const w = workerState(ctx, nameArg);
        if (!workerAlive(w) || !w.ready)
            await workerStart(ctx, {}, w.name);
        w.lastUsed = Date.now();
        metrics.workerExecs++;
        try {
            return await workerCall(w, { op: 'exec', code: String(code || ''), purgePrefixes: purgePrefixes || undefined }, timeoutMs);
        }
        catch (e) {
            w.lastError = errorMessage(e);
            throw e;
        }
    }
    async function workerSee(spec, nameArg) {
        const w = workerState(ctx, nameArg);
        if (!workerAlive(w) || !w.ready)
            await workerStart(ctx, {}, w.name);
        w.lastUsed = Date.now();
        metrics.workerExecs = (metrics.workerExecs || 0) + 1;
        try {
            return await workerCall(w, { op: 'see', spec: spec || {} }, 60000);
        }
        catch (e) {
            w.lastError = errorMessage(e);
            throw e;
        }
    }
    async function workerWatch(spec, nameArg) {
        const w = workerState(ctx, nameArg);
        if (!workerAlive(w) || !w.ready)
            await workerStart(ctx, { engine: 'workbench', warmup: true }, w.name);
        w.lastUsed = Date.now();
        metrics.workerExecs = (metrics.workerExecs || 0) + 1;
        try {
            return await workerCall(w, { op: 'watch', spec: spec || {} }, 180000);
        }
        catch (e) {
            w.lastError = errorMessage(e);
            throw e;
        }
    }
    async function workerReset(nameArg) {
        const w = workerState(ctx, nameArg);
        if (!workerAlive(w) || !w.ready)
            await workerStart(ctx, {}, w.name);
        try {
            return await workerCall(w, { op: 'reset' }, 60000);
        }
        catch (e) {
            w.lastError = errorMessage(e);
            throw e;
        }
    }
    async function workerStatus(nameArg) {
        const w = workerState(ctx, nameArg);
        if (!workerAlive(w) || !w.ready)
            return workerSnapshot(w);
        w.lastUsed = Date.now();
        try {
            const r = await workerCall(w, { op: 'status' }, 15000);
            return Object.assign(workerSnapshot(w), { status: r.status || null });
        }
        catch (e) {
            w.lastError = errorMessage(e);
            return Object.assign(workerSnapshot(w), { statusError: w.lastError });
        }
    }
    const { clearWorkerReaper, killWorkers } = createWorkerReaper(ctx);
    return {
        workerStart: start,
        workerExec,
        workerSee,
        workerWatch,
        workerReset,
        workerStatus,
        workerStop: (nameArg) => workerStop(ctx, nameArg),
        workerRestart: (nameArg, opts) => workerRestart(ctx, nameArg, opts),
        workerList: () => workerList(ctx),
        workerSnapshot,
        workerState: (name) => workerState(ctx, name),
        clearWorkerReaper,
        killWorkers,
    };
}
//# sourceMappingURL=index.js.map
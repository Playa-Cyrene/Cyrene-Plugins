// engine 装配：deps 上下文 + 各能力接线
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN_TMP } from '../../paths.js';
import { winToWsl } from '../../config.js';
import { launchBlender } from '../../launch/index.js';
import { gatewayInstances } from '../../transport/addon-ws.js';
import { createKernel } from '../kernel/index.js';
import { createRenderState } from '../render-state.js';
import { createDumpResult } from '../output/index.js';
import { createLedger } from '../../execution/ledger/index.js';
import { createTrajectory } from '../../execution/trajectory/index.js';
import { createJobsApi } from '../../execution/jobs/index.js';
import { createWorkersApi } from '../../execution/workers/index.js';
import { createTxnApi } from '../../execution/txn.js';
import { createPresetApi } from '../../execution/preset.js';
import { createEngineApi } from '../engine-api/index.js';
import { createPlanCallInner } from '../dispatcher/index.js';
import { createPlanDispatch } from '../plan-dispatch.js';
import { createHeadlessRun } from '../../execution/headless/index.js';
import { createEngineMetrics, installAddonSend } from './lifecycle.js';
const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export function createEngineContext(opts = {}) {
    const addon = opts.addonClient;
    if (!addon) {
        throw new Error('createEngine requires a Gateway addon client (3.1): no direct addon TCP path');
    }
    const { RENDER_FLAG_WSL, RENDER_FLAG_WIN, RENDER_STALE_MS, readRenderFlag, clearRenderFlag } = createRenderState({});
    // 需要 Blender 主线程的命令（ping 不在内：它走 addon 服务器线程，渲染中照样可用）
    const injected = new Set();
    const metrics = createEngineMetrics();
    installAddonSend(addon, metrics, readRenderFlag);
    const SESSION_NAME = String(process.env.DSH_SESSION || 'plugin-pid-' + process.pid);
    const RESULTS_DIR = path.join(winToWsl(WIN_TMP), 'results');
    const E = {
        addon,
        injected,
        metrics,
        RENDER_FLAG_WIN,
        RENDER_FLAG_WSL,
        RENDER_STALE_MS,
        readRenderFlag,
        clearRenderFlag,
        HERE: RUNTIME_DIR,
        SESSION_NAME,
        RESULTS_DIR,
    };
    return { addon, E, metrics, readRenderFlag };
}
export function assembleEngine(ctx) {
    const { E, addon, readRenderFlag } = ctx;
    const kernel = createKernel(E);
    Object.assign(E, kernel);
    E.dumpResult = createDumpResult(E).dumpResult;
    const ledger = createLedger(E);
    E.ledger = ledger;
    Object.assign(E, ledger);
    const trajectory = createTrajectory(E);
    Object.assign(E, trajectory);
    const jobsApi = createJobsApi(E);
    Object.assign(E, jobsApi);
    const workersApi = createWorkersApi(E);
    Object.assign(E, workersApi);
    const txnApi = createTxnApi(E);
    const presetApi = createPresetApi(E);
    const engineApi = createEngineApi(E);
    const dispatchApi = createPlanCallInner(E);
    E.planCallInner = dispatchApi.planCallInner;
    const planDispatch = createPlanDispatch(E);
    E.perfCall = planDispatch.perfCall;
    const perfCall = E.perfCall;
    const headlessApi = createHeadlessRun(E);
    const surface = {
        addon: addon,
        plan: (op, payload) => planDispatch.planCall(op, payload),
        txn: (op, payload) => txnApi.txnCall(op, payload),
        preset: (op, payload) => presetApi.presetCall(op, payload),
        worker: {
            start: workersApi.workerStart,
            exec: workersApi.workerExec,
            see: workersApi.workerSee,
            watch: workersApi.workerWatch,
            reset: workersApi.workerReset,
            status: workersApi.workerStatus,
            stop: workersApi.workerStop,
            restart: workersApi.workerRestart,
            list: workersApi.workerList,
            snapshot: workersApi.workerSnapshot,
            state: workersApi.workerState,
        },
        job: {
            start: jobsApi.jobStart,
            status: jobsApi.jobStatus,
            collect: jobsApi.jobCollect,
            kill: jobsApi.jobKill,
            list: jobsApi.jobList,
            wait: jobsApi.jobWait,
        },
        launchBlender: (o) => launchBlender((o || {}), {
            instanceCount: () => (gatewayInstances(addon) || []).filter((instance) => instance.ready).length,
        }),
        sceneEpoch: kernel.sceneEpoch,
        renderFlag: () => readRenderFlag(),
        ...engineApi,
        // perf / opt 是 perfCall 在 HTTP 路由（/perf、/opt）与脚本里的别名；原 engine-api/frame.ts
        // 的两层纯转发已收口到装配处（4.4）。行为不变：都直接走 plan-dispatch 的 perfCall。
        perf: (op, payload) => perfCall(op, payload),
        opt: (op, payload) => perfCall(op, payload),
        headless: headlessApi.headless,
        start: engineApi.start,
        stop: engineApi.stop,
    };
    return { surface: surface, trajectory };
}
//# sourceMappingURL=assemble.js.map
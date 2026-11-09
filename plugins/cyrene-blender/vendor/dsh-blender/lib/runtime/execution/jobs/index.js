// 作业层入口（拆分）：start/status/collect/wait/kill/list
import { createLedger } from '../ledger/index.js';
import { jobDir, jobArtifacts, jobSnapshot, tailFile } from './snapshot.js';
import { jobStart, jobStatus, jobCollect, jobWait, jobList } from './api.js';
import { jobKill } from './kill.js';
export function createJobsApi(E) {
    const ledger = E.ledger || createLedger(E);
    const jobs = new Map();
    const ctx = { E, jobs, ledger };
    return {
        jobs,
        jobStart: (opts = {}) => jobStart(ctx, opts),
        jobSnapshot,
        jobStatus: (id) => jobStatus(ctx, id),
        jobCollect: (id, tail) => jobCollect(ctx, id, tail),
        jobWait: (id, timeoutMs) => jobWait(ctx, id, timeoutMs),
        jobKill: (id) => jobKill(ctx, id),
        jobList: () => jobList(ctx),
        jobDir,
        jobArtifacts,
        tailFile,
        ledger,
    };
}
//# sourceMappingURL=index.js.map
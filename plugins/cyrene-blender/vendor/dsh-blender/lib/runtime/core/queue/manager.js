// Job queue manager: submission, admission, persistence, control.
import { randomUUID } from 'node:crypto';
import { availabilityFailure } from '../availability.js';
import { canManageJob, jobOwnerFromCaller, jobPermissionFailure } from '../sessions/job-owner.js';
import { JsonJobStore } from './store.js';
import { DEFAULT_CAPACITY, TERMINAL_STATES } from './types.js';
import { explainWaiting, nextAdmission, pendingCount, slotFor, slotUse } from './scheduler.js';
const LOG_CAP = 65536;
const WAIT_DEFAULT_MS = 120000;
const WAIT_MAX_MS = 600000;
export class QueueError extends Error {
    failure;
    constructor(failure) {
        super(failure.root_cause);
        this.name = 'QueueError';
        this.failure = failure;
    }
}
function terminalOf(state) {
    return TERMINAL_STATES.includes(state);
}
function queueFailure(code, rootCause, fix, evidence = {}) {
    return availabilityFailure({
        stage: 'queue',
        code,
        rootCause,
        fix,
        fallback: { kind: 'unavailable', summary: rootCause },
        evidence,
    });
}
export function failureForRestart() {
    return availabilityFailure({
        stage: 'queue',
        code: 'gateway_restart',
        rootCause: 'Gateway restarted while this job was assigned or running.',
        fix: 'Submit the job again; running work is never replayed automatically.',
        fallback: { kind: 'unavailable', summary: 'resubmit the job' },
        evidence: { reason: 'gateway_restart' },
    });
}
export class JobQueue {
    store;
    executor;
    capacity;
    reservedGpu;
    now;
    newId;
    jobs = [];
    handles = new Map();
    constructor(opts) {
        this.executor = opts.executor;
        this.store = opts.store || new JsonJobStore();
        this.capacity = { ...DEFAULT_CAPACITY, ...opts.capacity };
        this.reservedGpu = opts.reservedGpu || (() => 0);
        this.now = opts.now || (() => Date.now());
        this.newId = opts.id || (() => 'job-' + randomUUID());
        this.restore();
    }
    restore() {
        const loaded = this.store.load();
        for (const job of loaded) {
            if (job.state === 'assigned' || job.state === 'running') {
                this.transition(job, 'failed', 'gateway_restart');
                job.error = failureForRestart();
                job.finishedAt = this.now();
            }
            this.jobs.push(job);
        }
        if (loaded.length > 0)
            this.persist();
        this.pump();
    }
    submit(caller, input) {
        const kind = input.kind === 'render' || input.kind === 'headless' ? input.kind : null;
        if (!kind)
            throw new QueueError(queueFailure('queue_invalid_kind', 'kind must be render or headless', 'Pass kind=render or kind=headless.'));
        if (kind === 'render' && (input.script !== undefined || input.script_file !== undefined))
            throw new QueueError(queueFailure('queue_render_script', 'render does not execute Python scripts', 'Use kind=headless for a script.'));
        if (pendingCount(this.jobs) >= this.capacity.pending) {
            throw new QueueError(queueFailure('queue_full', 'The job queue is full.', 'Wait for a running job to finish, or raise the documented pending limit.', { pending: pendingCount(this.jobs), limit: this.capacity.pending }));
        }
        const job = {
            id: this.newId(),
            kind,
            params: { ...input },
            state: 'queued',
            priority: clampPriority(input.priority),
            slot: null,
            owner: jobOwnerFromCaller(caller),
            createdAt: this.now(),
            updatedAt: this.now(),
            assignedAt: null,
            startedAt: null,
            finishedAt: null,
            pid: null,
            decision: null,
            result: null,
            artifacts: [],
            logs: { stdout: '', stderr: '' },
            error: null,
            events: [],
        };
        delete job.params.kind;
        job.params.kind = kind;
        this.events(job, null, 'queued', 'submitted');
        this.jobs.push(job);
        this.persist();
        this.pump();
        return this.snapshot(job);
    }
    status(id) {
        const job = this.find(id);
        return job ? this.snapshot(job) : null;
    }
    async wait(_caller, id, timeoutMs = WAIT_DEFAULT_MS) {
        const budget = Math.max(1000, Math.min(WAIT_MAX_MS, Number(timeoutMs) || WAIT_DEFAULT_MS));
        const t0 = Date.now();
        for (;;) {
            const job = this.find(id);
            if (!job)
                throw new QueueError(queueFailure('queue_unknown_job', 'No job has id ' + id, 'Call op=list and use an existing jobId.'));
            if (terminalOf(job.state))
                return { job: this.snapshot(job), waitedMs: Date.now() - t0, waitTimedOut: false };
            if (Date.now() - t0 >= budget)
                return { job: this.snapshot(job), waitedMs: Date.now() - t0, waitTimedOut: true };
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    collect(caller, id, tail = 4000) {
        const job = this.find(id);
        if (!job)
            throw new QueueError(queueFailure('queue_unknown_job', 'No job has id ' + id, 'Call op=list and use an existing jobId.'));
        this.authorize(caller, job, 'collect');
        const snap = this.snapshot(job);
        return {
            job: {
                ...snap,
                logs: { stdout: tailText(job.logs.stdout, tail), stderr: tailText(job.logs.stderr, tail) },
            },
        };
    }
    cancel(caller, id) {
        const job = this.find(id);
        if (!job)
            throw new QueueError(queueFailure('queue_unknown_job', 'No job has id ' + id, 'Call op=list and use an existing jobId.'));
        this.authorize(caller, job, 'cancel');
        if (terminalOf(job.state))
            return { job: this.snapshot(job), canceled: false, alreadyFinished: true };
        const handle = this.handles.get(job.id);
        this.transition(job, 'canceled', 'cancel requested by caller');
        job.finishedAt = this.now();
        job.pid = null;
        this.handles.delete(job.id);
        if (handle) {
            try {
                handle.cancel();
            }
            catch {
                /* cancellation is idempotent */
            }
        }
        this.persist();
        this.pump();
        return { job: this.snapshot(job), canceled: true, alreadyFinished: false };
    }
    list(filter = {}) {
        return this.jobs
            .filter((job) => !filter.state || job.state === filter.state)
            .filter((job) => !filter.kind || job.kind === filter.kind)
            .filter((job) => !filter.owner || job.owner.dshSessionId === filter.owner)
            .map((job) => this.snapshot(job));
    }
    perf() {
        const byState = {};
        for (const state of ['queued', 'assigned', 'running', 'completed', 'failed', 'canceled'])
            byState[state] = this.jobs.filter((job) => job.state === state).length;
        return {
            pending: pendingCount(this.jobs),
            byState,
            capacity: { ...this.capacity },
            slots: {
                gpu: {
                    used: slotUse(this.jobs, 'gpu'),
                    total: this.capacity.gpu,
                    reserved: this.reservedGpu(),
                },
                cpu: { used: slotUse(this.jobs, 'cpu'), total: this.capacity.cpu },
            },
            oldestQueuedAt: this.oldestQueuedAt(),
        };
    }
    oldestQueuedAt() {
        const queued = this.jobs.filter((job) => job.state === 'queued');
        return queued.length === 0 ? null : Math.min(...queued.map((job) => job.createdAt));
    }
    pump() {
        for (;;) {
            const admission = nextAdmission(this.jobs, this.capacity, this.reservedGpu());
            if (!admission.job) {
                this.recordWaiting();
                return;
            }
            const job = admission.job;
            job.slot = slotFor(job.kind, job.params);
            job.decision = admission.decision;
            this.transition(job, 'assigned', admission.decision.reason);
            job.assignedAt = this.now();
            this.persist();
            this.start(job);
        }
    }
    recordWaiting() {
        const head = this.jobs
            .filter((job) => job.state === 'queued')
            .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0];
        if (!head)
            return;
        const next = explainWaiting(head, this.jobs, this.capacity, this.reservedGpu());
        if (JSON.stringify(head.decision) === JSON.stringify(next))
            return;
        head.decision = next;
        this.persist();
    }
    start(job) {
        let handle;
        try {
            handle = this.executor.start(this.snapshot(job));
        }
        catch (e) {
            this.fail(job, availabilityFailure({
                stage: 'spawn',
                code: 'job_spawn_failed',
                rootCause: e instanceof Error ? e.message : String(e),
                fix: 'Check the Blender executable and the submitted parameters, then retry.',
                fallback: { kind: 'unavailable', summary: 'retry the job' },
                evidence: { kind: job.kind, params: job.params },
            }));
            return;
        }
        this.handles.set(job.id, handle);
        job.pid = handle.pid;
        this.transition(job, 'running', 'slot acquired');
        this.persist();
        void handle.done.then((result) => this.finish(job, result), (error) => this.fail(job, availabilityFailure({
            stage: job.kind === 'render' ? 'render' : 'spawn',
            code: 'job_execution_failed',
            rootCause: error instanceof Error ? error.message : String(error),
            fix: 'Read the job logs, fix the reported cause, then resubmit.',
            fallback: { kind: 'unavailable', summary: 'resubmit the job' },
            evidence: { jobId: job.id },
        })));
    }
    finish(job, result) {
        if (terminalOf(job.state))
            return;
        this.handles.delete(job.id);
        job.logs = { stdout: cap(result.stdout), stderr: cap(result.stderr) };
        job.result = {
            exitCode: result.exitCode,
            signal: result.signal,
            ms: Date.now() - (job.startedAt || Date.now()),
            ...(result.parsed === undefined ? {} : { parsed: result.parsed }),
        };
        job.artifacts = result.artifacts || [];
        job.pid = null;
        if (result.error) {
            job.error = result.error;
            this.transition(job, 'failed', result.error.code);
        }
        else if (result.exitCode === 0) {
            this.transition(job, 'completed', 'process exited 0');
        }
        else {
            job.error = availabilityFailure({
                stage: job.kind === 'render' ? 'render' : 'spawn',
                code: 'job_exit_nonzero',
                rootCause: 'Blender exited with code ' + String(result.exitCode) + '.',
                fix: 'Read the job logs and fix the reported Blender error.',
                fallback: { kind: 'unavailable', summary: 'inspect logs then resubmit' },
                evidence: { exitCode: result.exitCode, signal: result.signal },
            });
            this.transition(job, 'failed', 'process exited nonzero');
        }
        job.finishedAt = this.now();
        this.persist();
        this.pump();
    }
    fail(job, failure) {
        if (terminalOf(job.state))
            return;
        this.handles.delete(job.id);
        job.error = failure;
        job.pid = null;
        this.transition(job, 'failed', failure.code);
        job.finishedAt = this.now();
        this.persist();
        this.pump();
    }
    transition(job, to, reason) {
        const from = job.state;
        job.state = to;
        job.updatedAt = this.now();
        this.events(job, from, to, reason);
    }
    events(job, from, to, reason) {
        job.events.push({ at: this.now(), from, to, slot: job.slot, pid: job.pid, reason });
    }
    authorize(caller, job, action) {
        const decision = canManageJob(caller, job.owner);
        if (!decision.allowed)
            throw new QueueError(queueFailure('job_ownership_denied', jobPermissionFailure(decision, action), 'Use the DSH session that submitted the job, its parent agent, or the main agent.', { action, reason: decision.reason }));
    }
    find(id) {
        return this.jobs.find((job) => job.id === id) || null;
    }
    snapshot(job) {
        return JSON.parse(JSON.stringify(job));
    }
    persist() {
        this.store.save(this.jobs.map((job) => this.snapshot(job)));
    }
}
function clampPriority(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(-100, Math.min(100, Math.trunc(n)));
}
function cap(text) {
    return text.length > LOG_CAP ? text.slice(-LOG_CAP) : text;
}
function tailText(text, tail) {
    const n = Math.max(0, Math.min(LOG_CAP, Number(tail) || 4000));
    return text.length > n ? text.slice(-n) : text;
}
//# sourceMappingURL=manager.js.map
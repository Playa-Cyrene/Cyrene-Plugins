import { QueueError } from './manager.js';
export function callerFromHeaders(headers) {
    const text = (name) => {
        const value = headers[name];
        return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    };
    const role = text('x-dsh-agent-role');
    return {
        hostId: text('x-dsh-host-id') || 'unknown-host',
        dshSessionId: text('x-dsh-session-id') || 'unknown-session',
        agentId: text('x-dsh-agent-id') || 'unknown-agent',
        ...(text('x-dsh-parent-agent-id') ? { parentAgentId: text('x-dsh-parent-agent-id') } : {}),
        ...(role === 'main' || role === 'subagent' ? { role } : {}),
    };
}
function failureResult(error) {
    return { ...error.failure, error: error.failure };
}
export class JobSurface {
    queue;
    constructor(queue) {
        this.queue = queue;
    }
    async handle(caller, payload) {
        const op = String(payload.op || 'list');
        try {
            if (op === 'submit') {
                const params = { ...payload };
                delete params.op;
                const job = this.queue.submit(caller, params);
                return { ok: true, op, job };
            }
            if (op === 'status') {
                const job = this.queue.status(String(payload.id || ''));
                return job ? { ok: true, op, job } : { ok: false, op, code: 'queue_unknown_job' };
            }
            if (op === 'wait')
                return {
                    ok: true,
                    op,
                    ...(await this.queue.wait(caller, String(payload.id || ''), Number(payload.timeout_ms) || 120000)),
                };
            if (op === 'collect')
                return {
                    ok: true,
                    op,
                    ...this.queue.collect(caller, String(payload.id || ''), Number(payload.tail) || 4000),
                };
            if (op === 'cancel')
                return { ok: true, op, ...this.queue.cancel(caller, String(payload.id || '')) };
            if (op === 'list')
                return {
                    ok: true,
                    op,
                    jobs: this.queue.list({
                        state: typeof payload.state === 'string' ? payload.state : undefined,
                        kind: typeof payload.kind === 'string' ? payload.kind : undefined,
                        owner: typeof payload.owner === 'string' ? payload.owner : undefined,
                    }),
                };
            if (op === 'perf')
                return { ok: true, op, perf: this.queue.perf() };
            return {
                ok: false,
                op,
                code: 'queue_unknown_op',
                error: 'unknown queue op: ' + op,
                hint: 'use submit, status, wait, collect, cancel, list, or perf',
            };
        }
        catch (e) {
            if (e instanceof QueueError)
                return { op, ...failureResult(e) };
            return {
                ok: false,
                op,
                code: 'queue_handler_error',
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }
}
//# sourceMappingURL=handler.js.map
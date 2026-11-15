// Job-queue types: one bounded queue for render and headless work.
//
// The queue is deliberately independent from the legacy synchronous headless
// path: a submitted job gets one id and is observed through the same record
// until it reaches a terminal state.
export const JOB_STATES = [
    'queued',
    'assigned',
    'running',
    'completed',
    'failed',
    'canceled',
];
export const TERMINAL_STATES = ['completed', 'failed', 'canceled'];
export const DEFAULT_CAPACITY = { pending: 64, gpu: 1, cpu: 2, ownerQuota: 8 };
//# sourceMappingURL=types.js.map
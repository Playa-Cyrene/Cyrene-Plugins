/** Long tasks are handed to the job layer instead of holding the client connection. */
export function isJobMode(opts, p) {
    const autoJobMs = Number(opts.autoJobMs) || 0;
    return !!opts.asJob || (autoJobMs > 0 && p.timeoutMs >= autoJobMs);
}
export function jobModeReceipt(input) {
    const { p, t0, job } = input;
    return {
        ok: true,
        mode: 'job',
        kind: 'job',
        ms: Date.now() - t0,
        jobId: job.id,
        runId: p.runId,
        job: job,
        logs: { stdout: job.stdoutLog, stderr: job.stderrLog },
        reason: null,
        hint: '已转作业层（长任务）：用 blender_run(action=""status"/"collect"/"wait", id="' +
            job.id +
            '") 跟进',
    };
}
//# sourceMappingURL=job-mode.js.map
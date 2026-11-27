// Structured display-provider failures shared by every platform provider.
//
// The session layer turns the `view()` object into the same availability
// envelope as the rest of the Gateway, so a provider must fail with stage,
// code, root cause, fix and evidence instead of a bare Error.
export class DisplayProviderError extends Error {
    stage;
    code;
    fix;
    evidence;
    constructor(stage, code, message, fix, evidence = {}) {
        super(message);
        this.name = 'DisplayProviderError';
        this.stage = stage;
        this.code = code;
        this.fix = fix;
        this.evidence = evidence;
    }
    /** The availability-envelope-shaped view used by callers and tests. */
    view() {
        return {
            ok: false,
            stage: this.stage,
            code: this.code,
            root_cause: this.message,
            fix: this.fix,
            evidence: this.evidence,
        };
    }
}
//# sourceMappingURL=errors.js.map
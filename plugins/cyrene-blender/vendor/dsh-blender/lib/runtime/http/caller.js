// Caller identity carried by the DSH host on every Gateway request.
//
// The Gateway serves one DSH host but may serve several DSH sessions (and
// subagents of each). These headers let it attribute ownership, scope grants,
// job ownership, and presence without trusting payload fields.
import { AsyncLocalStorage } from 'node:async_hooks';
const CALLER_CTX = new AsyncLocalStorage();
function header(req, name) {
    const raw = req.headers[name];
    if (Array.isArray(raw))
        return String(raw[0] || '');
    return raw === undefined ? '' : String(raw);
}
export function callerFromRequest(req) {
    const hostId = header(req, 'x-dsh-host-id');
    const dshSessionId = header(req, 'x-dsh-session-id');
    const agentId = header(req, 'x-dsh-agent-id');
    if (!hostId || !dshSessionId || !agentId)
        return null;
    const role = header(req, 'x-dsh-agent-role');
    return {
        hostId,
        dshSessionId,
        agentId,
        parentAgentId: header(req, 'x-dsh-parent-agent-id') || undefined,
        role: role === 'main' ? 'main' : 'subagent',
        callId: header(req, 'x-dsh-call-id') || undefined,
        turnId: header(req, 'x-dsh-turn-id') || undefined,
        displayName: header(req, 'x-dsh-display-name') || undefined,
    };
}
export function currentCaller() {
    return CALLER_CTX.getStore() || null;
}
export function runWithCaller(caller, fn) {
    if (!caller)
        return fn();
    return CALLER_CTX.run(caller, fn);
}
//# sourceMappingURL=caller.js.map
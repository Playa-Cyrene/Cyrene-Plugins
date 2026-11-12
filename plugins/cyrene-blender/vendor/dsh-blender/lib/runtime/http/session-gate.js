// Write gate for the 3.1 session/ownership model.
//
// Requests from the DSH host carry caller headers. When they do, the registry
// decides whether this caller owns the GUI session and holds a covering scope
// grant. Legacy clients without headers keep the 3.0 lease behaviour until the
// six-tool surface replaces them (slice 7).
import { currentCaller } from './caller.js';
import { availabilityFailure } from '../core/availability.js';
let REGISTRY = null;
export function setSessionRegistry(registry) {
    REGISTRY = registry;
}
export function sessionRegistry() {
    return REGISTRY;
}
function scopePayload(payload) {
    return payload.write_scope ?? payload.write_scopes ?? payload.scope;
}
/** Resolve the write scope declared by a route payload. */
export function writeScopesFor(payload, fallback) {
    const declared = scopePayload(payload);
    return declared === undefined ? fallback : declared;
}
export function sessionWriteGate(payload, fallbackScope = 'exclusive') {
    const caller = currentCaller();
    const registry = REGISTRY;
    if (!caller || !registry)
        return null;
    const body = (payload || {});
    const sessionId = body.sessionId === undefined ? undefined : String(body.sessionId);
    const result = registry.authorizeWrite(caller, sessionId, writeScopesFor(body, fallbackScope), {
        py: body.py === true,
    });
    if (result.ok)
        return null;
    return result;
}
export function gateResponse(failure) {
    return {
        ...failure,
        error: failure.code,
        hint: failure.fix,
    };
}
export { availabilityFailure };
//# sourceMappingURL=session-gate.js.map
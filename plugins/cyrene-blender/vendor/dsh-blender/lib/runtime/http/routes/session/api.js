// Gateway-facing session API used by the host's blender_session family.
//
// The existing /lease endpoint doubles as the action dispatcher so the 3.1
// route table keeps its frozen 29 entries; section 7 can expose the family
// without inventing a parallel transport.
import { currentCaller } from '../../caller.js';
function statusFor(result) {
    if (result.code === 'invalid_params')
        return 400;
    if (result.code === 'session_unavailable')
        return 503;
    if (result.code === 'feature_disabled')
        return 503;
    if (result.code === 'session_not_found')
        return 404;
    return 409;
}
function targetCaller(payload, base) {
    const hostId = String(payload.targetHostId || base.hostId);
    const dshSessionId = String(payload.targetDshSessionId || base.dshSessionId);
    const agentId = String(payload.targetAgentId || payload.agentId || base.agentId);
    const parentAgentId = String(payload.targetParentAgentId || '');
    return { hostId, dshSessionId, agentId, parentAgentId, role: 'subagent' };
}
export async function dispatchSessionAction(registry, action, payload) {
    const caller = currentCaller();
    if (!caller) {
        return {
            status: 400,
            body: {
                ok: false,
                code: 'caller_identity_required',
                error: 'session actions require X-DSH-Host-Id / X-DSH-Session-Id / X-DSH-Agent-Id',
            },
        };
    }
    const result = await runSessionAction(registry, caller, action, payload);
    if (!result.ok)
        return { status: statusFor(result), body: result };
    return { status: 200, body: result };
}
async function runSessionAction(registry, caller, action, payload) {
    const sessionId = payload.sessionId === undefined ? undefined : String(payload.sessionId);
    switch (action) {
        case 'list':
            return { ok: true, sessions: registry.listFor(caller) };
        case 'attach':
        case 'claim':
            return registry.attach(caller, {
                instanceId: payload.instanceId === undefined ? undefined : String(payload.instanceId),
                kind: payload.kind === undefined ? undefined : String(payload.kind),
            });
        case 'detach':
            return registry.detach(caller, sessionId);
        case 'release':
            return registry.release(caller, sessionId);
        case 'status':
            return registry.status(caller, sessionId);
        case 'doctor':
            return registry.doctor(caller, sessionId);
        case 'consent':
            return registry.issueConsent(caller);
        case 'start':
            return await registry.start(caller, {
                kind: payload.kind === undefined ? undefined : String(payload.kind),
                consentToken: payload.consentToken === undefined ? undefined : String(payload.consentToken),
            });
        case 'stop':
            return await registry.stop(caller, sessionId);
        case 'grant':
            return registry.grant(caller, String(sessionId || ''), payload.scopes === undefined ? payload.scope : payload.scopes, targetCaller(payload, caller), Number(payload.ttlMs));
        case 'revoke':
            return registry.revoke(caller, String(sessionId || ''), payload.grantId === undefined ? undefined : String(payload.grantId));
        case 'grants':
            return registry.grants(caller, sessionId);
        case 'pause':
            return registry.pause(caller, sessionId);
        case 'resume':
            return registry.resume(caller, sessionId);
        case 'mark_read':
            return registry.markRead(caller, sessionId, payload.scopes === undefined ? payload.scope : payload.scopes);
        case 'update_view':
            return registry.updateView(caller, String(sessionId || ''), (payload.view || {}));
        case 'update_selection':
            return registry.updateSelection(caller, String(sessionId || ''), Array.isArray(payload.selected) ? payload.selected.map(String) : [], payload.activity === undefined ? undefined : String(payload.activity));
        case 'presence':
            return registry.presence(caller, sessionId);
        case 'heartbeat':
            return registry.heartbeat(caller, sessionId);
        default:
            return {
                ok: false,
                code: 'invalid_params',
                stage: 'config',
                root_cause: 'unknown session action: ' + action,
                fix: 'use list, attach, claim, detach, release, status, doctor, consent, start, stop, grant, revoke, grants, pause, resume, mark_read, presence, update_view, update_selection, heartbeat',
                fallback: { kind: 'unavailable', summary: 'the session action was not executed' },
                evidence: { action },
            };
    }
}
export async function sessionAction(res, registry, payload) {
    return dispatchSessionAction(registry, String(payload.action || ''), payload);
}
//# sourceMappingURL=api.js.map
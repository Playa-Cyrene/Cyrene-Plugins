// 3.1 GUI session registry: ownership, scope grants, presence, and the
// session-level guard used by every Gateway write route.
//
// This is intentionally in-memory: the Gateway owns the live process/session
// state, and a Gateway restart recreates it from addon handshakes. No scene data
// is stored here; presence only keeps caller-visible view poses and labels.
import { availabilityFailure } from '../availability.js';
export const OWNER_TTL_MS = 120_000;
export const OWNER_HEARTBEAT_MS = 30_000;
export const GRANT_TTL_MS = 30_000;
export const GRANT_HEARTBEAT_MS = 10_000;
export const PY_WAIT_MAX_MS = 5_000;
export const COLORS = ['#4C8DFF', '#FF6B6B', '#2FBF71', '#F5A623', '#9B59B6', '#20B2AA'];
export function fail(code, stage, rootCause, fix, evidence = {}) {
    return availabilityFailure({
        stage,
        code,
        rootCause,
        fix,
        fallback: { kind: 'unavailable', summary: 'operation unavailable' },
        evidence,
    });
}
export function callerKey(c) {
    return [c.hostId, c.dshSessionId, c.agentId].map((x) => String(x || '')).join('|');
}
export function ownerOf(c) {
    return {
        hostId: String(c.hostId || ''),
        dshSessionId: String(c.dshSessionId || ''),
        agentId: String(c.agentId || ''),
        claimedAt: Date.now(),
        heartbeatAt: Date.now(),
    };
}
export function ownerMatches(owner, c) {
    return !!owner && owner.hostId === c.hostId && owner.dshSessionId === c.dshSessionId;
}
export function isMain(session, c) {
    return !!session.owner && session.owner.agentId === c.agentId && ownerMatches(session.owner, c);
}
export function colourFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++)
        h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
}
export function callerView(c) {
    return {
        hostId: c.hostId,
        dshSessionId: c.dshSessionId,
        agentId: c.agentId,
        parentAgentId: c.parentAgentId || null,
        role: c.role || 'subagent',
    };
}
export function grantView(g) {
    return {
        id: g.id,
        holder: callerView(g.holder),
        grantedBy: callerView(g.grantedBy),
        scopes: g.scopes,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        expiresInMs: Math.max(0, g.expiresAt - Date.now()),
    };
}
export function sessionView(s) {
    return {
        id: s.id,
        kind: s.kind,
        instanceId: s.instanceId,
        status: s.status,
        owner: s.owner
            ? {
                hostId: s.owner.hostId,
                dshSessionId: s.owner.dshSessionId,
                agentId: s.owner.agentId,
                claimedAt: s.owner.claimedAt,
                heartbeatAt: s.owner.heartbeatAt,
                expiresInMs: Math.max(0, s.owner.heartbeatAt + OWNER_TTL_MS - Date.now()),
            }
            : null,
        paused: s.paused,
        agents: [...s.agents.values()].map((a) => ({
            agent: callerView(a.caller),
            displayName: a.displayName,
            color: a.color,
            attachedAt: a.attachedAt,
            lastSeen: a.lastSeen,
            view: a.view,
            selected: a.selected,
            activity: a.activity,
        })),
        grants: [...s.grants.values()].map(grantView),
        activePy: s.activePy
            ? { holder: callerView(s.activePy.caller), startedAt: s.activePy.startedAt }
            : null,
        display: s.display
            ? {
                id: s.display.id,
                provider: s.display.provider,
                display: s.display.display,
                pid: s.display.pid,
            }
            : null,
        humanModified: s.humanEdits.size
            ? {
                at: s.humanModifiedAt,
                objects: [...s.humanEdits.values()]
                    .filter((edit) => edit.kind === 'object')
                    .map((edit) => ({ name: edit.name, revision: edit.revision })),
                collections: [...s.humanEdits.values()]
                    .filter((edit) => edit.kind === 'collection')
                    .map((edit) => ({ name: edit.name, revision: edit.revision })),
            }
            : null,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
    };
}
//# sourceMappingURL=types.js.map
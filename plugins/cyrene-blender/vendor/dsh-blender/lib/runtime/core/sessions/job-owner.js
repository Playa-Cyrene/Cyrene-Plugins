// Job ownership rules shared by the queue and the six-tool surface.
//
// Queue jobs are created by an agent call, so cancellation and collection are
// restricted to that agent, its parent agent, and the main agent of the same
// DSH session. The rule is pure so section 6 can apply it to persisted jobs
// without importing queue state here.
export function jobOwnerFromCaller(c) {
    return {
        hostId: String(c.hostId || ''),
        dshSessionId: String(c.dshSessionId || ''),
        agentId: String(c.agentId || ''),
        ...(c.parentAgentId ? { parentAgentId: String(c.parentAgentId) } : {}),
    };
}
export function canManageJob(c, owner) {
    if (owner.hostId !== c.hostId || owner.dshSessionId !== c.dshSessionId)
        return { allowed: false, reason: 'other_session' };
    if (owner.agentId === c.agentId)
        return { allowed: true, reason: 'owner' };
    if (owner.parentAgentId && owner.parentAgentId === c.agentId)
        return { allowed: true, reason: 'parent' };
    if (c.role === 'main')
        return { allowed: true, reason: 'main' };
    return { allowed: false, reason: 'not_owner' };
}
export function jobPermissionFailure(decision, action) {
    if (decision.allowed)
        return '';
    if (decision.reason === 'other_session')
        return action + ' is limited to the DSH session that submitted the job';
    return action + ' is limited to the owning agent, its parent agent, or the main agent';
}
//# sourceMappingURL=job-owner.js.map
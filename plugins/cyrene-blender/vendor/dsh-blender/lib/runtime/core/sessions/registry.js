import { claimExisting, createSession, pickInstance } from './attach.js';
import { issueConsentToken } from './consent.js';
import { CFG } from '../../config.js';
import { selectDisplayProvider } from '../../display/provider.js';
import { systemVirtualGuiLimits } from '../../display/limits.js';
import { applyHumanPause } from './human.js';
import { applyHumanEditsToSessions, markHumanRead } from './human-edits.js';
import { presenceRows, setSelection, setView, touchAgent } from './presence.js';
import { pyTimeoutFailure, waitForPyLock } from './py-lock.js';
import { grantTo, listGrants, revokeFrom } from './grant-ops.js';
import { displayCapabilities } from '../../display/prerequisites.js';
import { authorizeMainWrite, coveringGrant, evaluateWriteGate } from './write-gate.js';
import { callerKey, callerView, fail, grantView, isMain, ownerMatches, ownerOf, sessionView, } from './types.js';
import { findCallerSession, pruneSessions } from './lookup.js';
import { VirtualGuiLifecycle, waitForAddonInstance } from './virtual-gui.js';
function defaultProviderSelector(capabilities) {
    return selectDisplayProvider({ capabilities }).provider;
}
export class SessionRegistry {
    sessions = new Map();
    instances = [];
    humanPaused = new Map();
    constructor(instances, options = {}) {
        const opts = typeof options === 'function' ? { display: options } : options;
        this.listInstances = instances;
        this.displayFn = opts.display || displayCapabilities;
        this.limitsFn = opts.limits || (() => systemVirtualGuiLimits(CFG.features.virtualGuiMax));
        this.waitForInstanceFn =
            opts.waitForInstance ||
                ((instanceId, timeoutMs) => waitForAddonInstance(() => this.listInstances(), instanceId, timeoutMs));
        this.lifecycle = new VirtualGuiLifecycle(this, opts.selectProvider || defaultProviderSelector);
    }
    listInstances;
    displayFn;
    limitsFn;
    waitForInstanceFn;
    lifecycle;
    display() {
        return this.displayFn();
    }
    refreshInstances(next) {
        this.instances = next;
    }
    prune(now = Date.now()) {
        this.instances = pruneSessions(this.sessions, this.listInstances, now);
    }
    findForCaller(c) {
        return findCallerSession(this.sessions, c);
    }
    ensureAttached(c, opts = {}) {
        this.prune();
        const requested = opts.instanceId ? 'user-gui:' + String(opts.instanceId) : '';
        const existing = requested ? (this.sessions.get(requested) ?? null) : this.findForCaller(c);
        if (existing)
            return this.adopt(claimExisting(existing, c), c);
        const picked = pickInstance(this.listInstances(), opts);
        if (!('instance' in picked))
            return picked;
        const knownVirtual = this.sessions.get('virtual-gui:' + picked.instance.instanceId);
        if (knownVirtual) {
            if (knownVirtual.status !== 'ready')
                return fail('session_unavailable', 'session', 'the virtual-gui session is not ready yet', 'wait for the addon handshake, or check blender_session status', { sessionId: knownVirtual.id });
            if (!ownerMatches(knownVirtual.owner, c))
                return fail('session_in_use', 'session', 'another DSH session owns this virtual-gui session', 'ask the owner to release it', { sessionId: knownVirtual.id });
            return this.adopt(claimExisting(knownVirtual, c), c);
        }
        const known = this.sessions.get('user-gui:' + picked.instance.instanceId);
        if (known)
            return this.adopt(claimExisting(known, c), c);
        const created = createSession(picked.instance, c);
        created.paused = this.humanPaused.get(picked.instance.instanceId) === true;
        if (created.paused)
            created.pausedAt = Date.now();
        this.sessions.set(created.id, created);
        touchAgent(created, c);
        return { ok: true, session: created };
    }
    adopt(result, c) {
        if (result.ok)
            touchAgent(result.session, c);
        return result;
    }
    list() {
        this.prune();
        return [...this.sessions.values()].map(sessionView);
    }
    listFor(c) {
        const s = this.findForCaller(c);
        return s ? [sessionView(s)] : [];
    }
    status(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session)
            return fail('session_not_found', 'session', 'the session does not exist', 'call blender_session list to see live sessions', { sessionId: sessionId || null });
        if (ownerMatches(session.owner, c) || session.agents.has(callerKey(c)))
            touchAgent(session, c);
        return { ok: true, session: sessionView(session) };
    }
    attach(c, opts = {}) {
        if (opts.kind && opts.kind !== 'user-gui') {
            return fail('invalid_params', 'session', 'attach only applies to user-gui; virtual-gui sessions are started by the Gateway', 'use blender_session start kind=virtual-gui', { kind: opts.kind });
        }
        const r = this.ensureAttached(c, opts);
        if (!('session' in r))
            return r;
        return { ok: true, session: sessionView(r.session) };
    }
    claim(c, opts = {}) {
        return this.attach(c, opts);
    }
    detach(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session)
            return { ok: true, released: false };
        if (session.owner && ownerMatches(session.owner, c) && isMain(session, c)) {
            this.releaseSession(session);
            return { ok: true, released: true };
        }
        session.agents.delete(callerKey(c));
        return { ok: true, released: false };
    }
    release(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session)
            return { ok: true, released: false };
        if (!ownerMatches(session.owner, c)) {
            return fail('session_in_use', 'session', 'only the owning DSH session can release this GUI session', 'ask the owner to release it', { sessionId: session.id, owner: session.owner });
        }
        this.releaseSession(session);
        return { ok: true, released: true };
    }
    releaseSession(s) {
        s.owner = null;
        s.agents.clear();
        s.grants.clear();
        s.activePy = null;
        s.paused = false;
        s.pausedAt = null;
        s.humanEdits.clear();
        s.humanModifiedAt = null;
        s.status = 'stopped';
        if (s.kind === 'virtual-gui') {
            // Releasing the owner tears the provider down too; stop() awaits the same
            // dispose path, while detach/release can stay synchronous at the API edge.
            this.sessions.delete(s.id);
            void this.lifecycle.disposeSession(s);
        }
    }
    getSession(sessionId) {
        return this.sessions.get(String(sessionId)) ?? null;
    }
    virtualGuiCount() {
        let count = 0;
        for (const s of this.sessions.values()) {
            if (s.kind === 'virtual-gui' && (s.status === 'starting' || s.status === 'ready'))
                count++;
        }
        return count;
    }
    addSession(session) {
        this.sessions.set(session.id, session);
    }
    removeSession(sessionId) {
        this.sessions.delete(sessionId);
    }
    /** The addon socket dropped: a virtual-gui session for it cannot outlive it. */
    handleInstanceGone(instanceId) {
        const session = this.sessions.get('virtual-gui:' + String(instanceId));
        if (!session)
            return;
        session.status = 'stopped';
        this.sessions.delete(session.id);
        void this.lifecycle.disposeSession(session);
    }
    limits() {
        return this.limitsFn();
    }
    waitForInstance(instanceId, timeoutMs) {
        return this.waitForInstanceFn(instanceId, timeoutMs);
    }
    heartbeat(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session)
            return fail('session_not_found', 'session', 'the session does not exist', 're-attach the GUI session', {});
        if (session.owner && !ownerMatches(session.owner, c)) {
            return fail('session_in_use', 'session', 'another DSH session owns this GUI session', 'wait for the owner to release it', { sessionId: session.id });
        }
        if (!session.owner)
            session.owner = ownerOf(c);
        session.owner.heartbeatAt = Date.now();
        touchAgent(session, c);
        return { ok: true, session: sessionView(session) };
    }
    doctor(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        const ready = this.listInstances().filter((x) => x.ready);
        return {
            ok: true,
            readiness: {
                ready: !!session &&
                    session.status === 'ready' &&
                    !!session.owner &&
                    ownerMatches(session.owner, c),
                session_ready: !!session && session.status === 'ready',
                instances: ready.length,
                sessionId: session ? session.id : null,
                owner: session ? session.owner : null,
                paused: session ? session.paused : false,
                activePy: session && session.activePy ? callerView(session.activePy.caller) : null,
            },
            session: session ? sessionView(session) : null,
        };
    }
    async start(c, opts = {}) {
        this.prune();
        return this.lifecycle.start(c, opts);
    }
    issueConsent(c) {
        return { ok: true, ...issueConsentToken(c) };
    }
    async stop(c, sessionId) {
        this.prune();
        return this.lifecycle.stop(c, sessionId);
    }
    grant(c, sessionId, scopes, target, ttlMs) {
        return grantTo(this.grantHost(), c, sessionId, scopes, target, ttlMs);
    }
    revoke(c, sessionId, grantId) {
        return revokeFrom(this.grantHost(), c, sessionId, grantId);
    }
    grants(c, sessionId) {
        return listGrants(this.grantHost(), c, sessionId);
    }
    grantHost() {
        return {
            sessions: this.sessions,
            prune: () => this.prune(),
            findForCaller: (caller) => this.findForCaller(caller),
        };
    }
    pause(c, _sessionId) {
        return fail('human_action_required', 'session', 'agent calls cannot pause Blender writes', 'ask the human to pause AI operations in the Blender N-panel', { caller: callerView(c) });
    }
    resume(c, _sessionId) {
        return fail('human_action_required', 'session', 'only the human can resume agent writes in Blender', 'resume AI operations in the Blender N-panel', { caller: callerView(c) });
    }
    mustOwn(c, sessionId) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session)
            return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {});
        if (!ownerMatches(session.owner, c))
            return fail('session_in_use', 'session', 'another DSH session owns this GUI session', 'wait for the owner to release it', {});
        return { ok: true, session };
    }
    presence(c, sessionId) {
        const r = this.status(c, sessionId);
        if (!('session' in r))
            return r;
        const session = this.sessions.get(String(r.session.id));
        return { ok: true, presence: session ? presenceRows(session) : [] };
    }
    updateView(c, sessionId, view) {
        const r = this.writableSession(c, sessionId);
        if (!('session' in r))
            return r;
        return { ok: true, presence: setView(r.session, c, view) };
    }
    updateSelection(c, sessionId, selected, activity) {
        this.prune();
        const r = this.writableSession(c, sessionId);
        if (!('session' in r))
            return r;
        return { ok: true, presence: setSelection(r.session, c, selected, activity) };
    }
    writableSession(c, sessionId) {
        this.prune();
        const session = this.sessions.get(String(sessionId));
        if (!session)
            return fail('session_not_found', 'session', 'the session does not exist', 'attach first', {});
        if (!ownerMatches(session.owner, c))
            return fail('session_in_use', 'session', 'another DSH session owns this GUI session', 'wait for the owner to release it', {});
        return { ok: true, session };
    }
    /** Authorize one write call. Returns the owning session or a structured failure. */
    authorizeWrite(c, sessionId, scopes, opts = {}) {
        this.prune();
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session) {
            return fail('session_unavailable', 'session', 'no GUI session is attached for this caller', 'attach a ready Blender session first', {});
        }
        if (!ownerMatches(session.owner, c)) {
            return fail('session_in_use', 'session', 'another DSH session owns this GUI session', 'wait for the owner to release it', { sessionId: session.id, owner: session.owner });
        }
        const gate = evaluateWriteGate(session, c, scopes, opts);
        if (!('effective' in gate))
            return gate;
        const { effective } = gate;
        if (isMain(session, c)) {
            const main = authorizeMainWrite(session, c, effective);
            if (!main.ok)
                return main;
            return { ok: true, sessionId: session.id, mode: 'main' };
        }
        const grant = coveringGrant(session, c, effective);
        if (grant)
            return { ok: true, sessionId: session.id, mode: 'grant', grantId: grant.id };
        return fail('scope_required', 'session', 'the write scope was not granted to this agent', 'ask the main agent to grant the declared scope', {
            requested: effective,
            held: [...session.grants.values()]
                .filter((g) => callerKey(g.holder) === callerKey(c))
                .map(grantView),
        });
    }
    async beginPy(c, sessionId, waitMs = 0) {
        const r = await waitForPyLock(() => this.authorizeWrite(c, sessionId, [{ kind: 'exclusive' }], { py: true }), waitMs);
        if (!('sessionId' in r))
            return r;
        const session = this.sessions.get(r.sessionId);
        if (!session)
            return fail('session_not_found', 'session', 'the session disappeared', 're-attach', {});
        session.activePy = { caller: { ...c }, startedAt: Date.now() };
        return { ok: true, sessionId: session.id };
    }
    /** Report a timed-out Python call without releasing the lock. */
    timeoutPy(c, sessionId) {
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        return session ? pyTimeoutFailure(session, c) : { ok: true, running: false };
    }
    applyHumanEdits(instanceId, edits) {
        return applyHumanEditsToSessions(this.sessions, instanceId, edits);
    }
    markRead(c, sessionId, scopes) {
        this.prune();
        return markHumanRead(this.sessions, c, sessionId, scopes);
    }
    applyHumanPause(instanceId, paused) {
        const id = String(instanceId || '');
        if (id)
            this.humanPaused.set(id, paused);
        return applyHumanPause(this.sessions, instanceId, paused);
    }
    endPy(c, sessionId) {
        const session = sessionId ? this.sessions.get(String(sessionId)) : this.findForCaller(c);
        if (!session || !session.activePy)
            return { ok: true, released: false };
        if (callerKey(session.activePy.caller) !== callerKey(c) && !isMain(session, c)) {
            return fail('scope_forbidden', 'session', 'only the holder or the main agent can end Python execution', 'ask the holder to finish', {});
        }
        session.activePy = null;
        return { ok: true, released: true };
    }
}
//# sourceMappingURL=registry.js.map
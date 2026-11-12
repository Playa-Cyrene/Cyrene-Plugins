// Agent presence rows for one GUI session.
//
// Presence is caller-visible state only: display name, colour, view pose,
// selection, activity and held scopes. Nothing here touches bpy; the add-on
// draws the frusta from the same payload.
import { publishPresence } from './presence-publish.js';
import { callerKey, callerView, colourFor } from './types.js';
export function touchAgent(s, c) {
    const key = callerKey(c);
    const now = Date.now();
    let agent = s.agents.get(key);
    if (!agent) {
        agent = {
            caller: { ...c },
            attachedAt: now,
            lastSeen: now,
            view: null,
            selected: [],
            activity: 'idle',
            color: String(c.color || colourFor(key)),
            displayName: String(c.displayName || c.agentId || 'agent'),
        };
        s.agents.set(key, agent);
    }
    else {
        agent.caller = { ...agent.caller, ...c };
        agent.lastSeen = now;
    }
    s.lastActivityAt = now;
    return agent;
}
export function setView(s, c, view) {
    const agent = touchAgent(s, c);
    agent.view = { ...view, updatedAt: Date.now() };
    const rows = presenceRows(s);
    publishPresence(s, rows);
    return rows;
}
export function setSelection(s, c, selected, activity) {
    const agent = touchAgent(s, c);
    agent.selected = selected.map(String).slice(0, 256);
    if (activity)
        agent.activity = String(activity);
    const rows = presenceRows(s);
    publishPresence(s, rows);
    return rows;
}
export function presenceRows(s) {
    return [...s.agents.values()].map((a) => ({
        agent: callerView(a.caller),
        displayName: a.displayName,
        color: a.color,
        attachedAt: a.attachedAt,
        lastSeen: a.lastSeen,
        view: a.view,
        selected: a.selected,
        activity: a.activity,
    }));
}
//# sourceMappingURL=presence.js.map
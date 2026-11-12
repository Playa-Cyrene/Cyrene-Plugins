let publisher = null;
export function setPresencePublisher(next) {
    publisher = next;
}
export function publishPresence(session, rows) {
    if (!publisher || session.kind !== 'user-gui' || !session.instanceId)
        return;
    publisher({
        instanceId: session.instanceId,
        agents: rows,
        paused: session.paused,
    });
}
//# sourceMappingURL=presence-publish.js.map
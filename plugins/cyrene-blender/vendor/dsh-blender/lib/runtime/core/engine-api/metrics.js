export function metricsView(E) {
    const metrics = E.metrics;
    return { ...metrics, lastCmdAgeMs: metrics.lastCmdAt ? Date.now() - metrics.lastCmdAt : null };
}
export function createMetricsApi(E) {
    const { metrics } = E;
    return {
        metrics() {
            return { ...metrics, lastCmdAgeMs: metrics.lastCmdAt ? Date.now() - metrics.lastCmdAt : null };
        },
        /** 通道实际用的 addon 协议（显式配置 or auto 探测结果） */
    };
}
//# sourceMappingURL=metrics.js.map
// worker 登记与单次请求
import net from 'node:net';
export function workerKey(n) {
    const k = String(n === undefined || n === null || n === '' ? 'default' : n)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .slice(0, 24);
    return k || 'default';
}
export function workerState(ctx, name) {
    const key = workerKey(name);
    const found = ctx.WORKERS.get(key);
    if (found)
        return found;
    const used = new Set(Array.from(ctx.WORKERS.values()).map((x) => x.port));
    let p = ctx.WORKER_PORT;
    while (used.has(p))
        p += 1; // 端口顺延，避免两个实例撞车
    const w = {
        name: key,
        child: null,
        port: p,
        ready: false,
        startedAt: null,
        gpu: null,
        pid: null,
        lastError: null,
        stdoutTail: '',
        stderrTail: '',
    };
    ctx.WORKERS.set(key, w);
    return w;
}
export function workerAlive(w) {
    return !!(w && w.child && w.child.exitCode === null && !w.child.signalCode);
}
export function workerSnapshot(w) {
    return {
        name: w.name,
        alive: workerAlive(w),
        ready: w.ready,
        pid: w.pid,
        port: w.port,
        uptimeMs: w.startedAt ? Date.now() - w.startedAt : null,
        idleMs: w.lastUsed ? Date.now() - w.lastUsed : null,
        gpu: w.gpu,
        boot: w.boot || null,
        lastError: w.lastError,
        stdoutTail: w.stdoutTail ? w.stdoutTail.slice(-1200) : null,
    };
}
export function workerList(ctx) {
    return Array.from(ctx.WORKERS.values()).map((w) => workerSnapshot(w));
}
/** 与 worker 的单次请求-应答（每次新建短连接，避免残留状态） */
export function workerCall(w, req, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const s = net.connect({ host: '127.0.0.1', port: w.port });
        let buf = '';
        let settled = false;
        const done = (v) => {
            if (settled)
                return;
            settled = true;
            try {
                s.destroy();
            }
            catch (e) {
                /* ignore */
            }
            resolve(v);
        };
        const fail = (e) => {
            if (settled)
                return;
            settled = true;
            try {
                s.destroy();
            }
            catch (e2) {
                /* ignore */
            }
            reject(e);
        };
        const t = setTimeout(() => fail(new Error('worker 响应超时 ' + timeoutMs + 'ms（长代码会占住 worker；可 op=status 看状态）')), timeoutMs);
        s.once('connect', () => s.write(JSON.stringify(Object.assign({ id: id }, req)) + '\n'));
        s.once('error', (e) => {
            clearTimeout(t);
            fail(e);
        });
        s.on('data', (d) => {
            buf += d.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim())
                    continue;
                let obj;
                try {
                    obj = JSON.parse(line);
                }
                catch (e) {
                    continue;
                }
                if (!obj)
                    continue;
                if (obj.id !== undefined && obj.id !== null && obj.id !== id)
                    continue;
                clearTimeout(t);
                done(obj);
                return;
            }
        });
    });
}
//# sourceMappingURL=api.js.map
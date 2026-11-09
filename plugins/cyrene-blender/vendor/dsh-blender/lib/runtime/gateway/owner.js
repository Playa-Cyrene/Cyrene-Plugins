// Gateway owner state: one file per port. The file is diagnostic and gives a
// second DSH host enough identity to fail closed with GATEWAY_IN_USE.
import fs from 'node:fs';
import path from 'node:path';
import { CFG } from '../config.js';
export function gatewayStatePath(port) {
    return path.join(CFG.workDirWsl, 'gateway-' + String(port) + '.json');
}
export function writeGatewayOwner(owner) {
    const p = gatewayStatePath(owner.port ?? 0);
    const tmp = p + '.tmp';
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(owner), 'utf8');
        fs.renameSync(tmp, p);
    }
    catch (e) {
        /* state file is diagnostic; not fatal */
    }
}
export function removeGatewayOwner(port) {
    try {
        fs.unlinkSync(gatewayStatePath(port));
    }
    catch (e) {
        /* ignore */
    }
}
/** Exported for tests / host status: read the owner state file of a port. */
export function readGatewayOwner(port) {
    try {
        const parsed = JSON.parse(fs.readFileSync(gatewayStatePath(port), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch (e) {
        return null;
    }
}
export function gatewayHostId() {
    return String(process.env.DSH_HOST_ID || CFG.holder || 'host-pid-' + String(process.pid));
}
//# sourceMappingURL=owner.js.map
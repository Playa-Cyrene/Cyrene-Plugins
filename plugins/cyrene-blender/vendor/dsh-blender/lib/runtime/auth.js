// Cyrene uses separate, per-launch credentials for host control and addon pairing.
import { timingSafeEqual } from 'node:crypto';

export function createTokenVerifier(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
        throw new Error('Cyrene gateway requires a fresh 256-bit authentication token.');
    const expected = Buffer.from(token, 'ascii');
    return (req) => {
        const supplied = req.headers['x-cyrene-token'];
        if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied))
            return false;
        return timingSafeEqual(expected, Buffer.from(supplied, 'ascii'));
    };
}

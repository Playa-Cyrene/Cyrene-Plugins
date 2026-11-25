// Addon handshake contract (protocol 12) shared by the Gateway endpoint and callers.
// The addon dials the Gateway; Gateway validates and registers the instance.
import { ADDON_KINDS, ADDON_PROTOCOL_VERSION, HANDSHAKE_REQUIRED_FIELDS, } from './gateway-schema.generated.js';
const REQUIRED = HANDSHAKE_REQUIRED_FIELDS;
const UPGRADE_FIX = '升级 Blender 中的 DSH Blender Bridge 扩展到 2.0.0（protocol 12），然后重启 Blender；3.1 不支持旧 addon。';
function fail(code, message, fix, upgradeRequired = false) {
    return {
        ok: false,
        stage: 'handshake',
        code,
        message,
        fix,
        ...(upgradeRequired ? { upgrade_required: true } : {}),
    };
}
/** Validate and normalise one addon handshake; never throws on hostile input. */
export function validateHandshake(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fail('invalid_field', '握手必须是 JSON 对象。', '升级 addon 到 2.0.0 后重连 Gateway。', true);
    }
    const raw = value;
    for (const field of REQUIRED) {
        if (raw[field] === undefined || raw[field] === null) {
            return fail('missing_field', '握手缺少字段 ' + field + '。', UPGRADE_FIX, true);
        }
    }
    if (typeof raw.protocol !== 'number' || !Number.isInteger(raw.protocol)) {
        return fail('invalid_field', '握手字段 protocol 必须是整数。', UPGRADE_FIX, true);
    }
    if (raw.protocol !== ADDON_PROTOCOL_VERSION) {
        return fail('unsupported_protocol', 'addon 协议版本 ' +
            String(raw.protocol) +
            ' 不受支持（需要 ' +
            String(ADDON_PROTOCOL_VERSION) +
            '）。', UPGRADE_FIX, true);
    }
    if (typeof raw.instanceId !== 'string' || raw.instanceId.trim() === '') {
        return fail('invalid_field', '握手字段 instanceId 必须是非空字符串。', UPGRADE_FIX, true);
    }
    if (typeof raw.kind !== 'string' || !ADDON_KINDS.includes(raw.kind)) {
        return fail('unknown_kind', '未知的 addon kind：' + String(raw.kind) + '（允许 ' + ADDON_KINDS.join(' / ') + '）。', 'Blender 侧 addon 需要升级到 2.0.0 并重新连接 Gateway。', true);
    }
    if (typeof raw.version !== 'string' || raw.version.trim() === '') {
        return fail('invalid_field', '握手字段 version 必须是非空字符串。', UPGRADE_FIX, true);
    }
    if (typeof raw.project !== 'string') {
        return fail('invalid_field', '握手字段 project 必须是字符串（未保存场景用空串）。', UPGRADE_FIX);
    }
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string')) {
        return fail('invalid_field', '握手字段 capabilities 必须是字符串数组。', UPGRADE_FIX);
    }
    return {
        ok: true,
        handshake: {
            instanceId: raw.instanceId,
            kind: raw.kind,
            version: raw.version,
            protocol: raw.protocol,
            project: raw.project,
            capabilities: raw.capabilities.slice(),
        },
    };
}
/** Return the instance registry when `addon` is a Gateway client (3.1), null for the legacy TCP client. */
export function gatewayInstances(addon) {
    const value = addon?.instances;
    return Array.isArray(value) ? value : null;
}
/** Return the last rejected handshake on a Gateway client, null for the legacy client. */
export function gatewayHandshakeError(addon) {
    const value = addon?.lastHandshakeError;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
//# sourceMappingURL=addon-handshake.js.map
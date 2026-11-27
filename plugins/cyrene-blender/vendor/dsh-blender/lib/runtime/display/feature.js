/** Flipped by the V0 acceptance task (5.5); tests pin both sides. */
export const VIRTUAL_GUI_V0_RELEASED = true;
export function parseVirtualGuiFeature(value) {
    const raw = String(value === undefined || value === null ? '' : value)
        .trim()
        .toLowerCase();
    if (raw === 'off' || raw === 'false' || raw === '0')
        return 'off';
    if (raw === 'auto')
        return 'auto';
    if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'preview')
        return 'on';
    return null;
}
/**
 * Resolve the effective feature value.
 * - Windows: default off before V0, auto after V0.
 * - Linux/macOS: default off; only an explicit "on" enables the preview path.
 * - An unparseable value fails closed to off and reports its source.
 */
export function resolveVirtualGuiFeature(input) {
    const platform = input.platform || process.platform;
    const v0 = input.v0Released === undefined ? VIRTUAL_GUI_V0_RELEASED : input.v0Released === true;
    const configured = input.configured;
    const parsed = parseVirtualGuiFeature(configured);
    if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
        if (!parsed)
            return { value: 'off', source: (input.source || 'config') + ':invalid' };
        if (platform !== 'win32' && parsed === 'auto') {
            return { value: 'off', source: (input.source || 'config') + ':auto-is-windows-only' };
        }
        return { value: parsed, source: input.source || 'config' };
    }
    if (platform === 'win32')
        return { value: v0 ? 'auto' : 'off', source: 'default:v0' };
    return { value: 'off', source: 'default:non-windows' };
}
//# sourceMappingURL=feature.js.map
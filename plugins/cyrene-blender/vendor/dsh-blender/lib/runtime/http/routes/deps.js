/** JSON 对象的边界解析：非对象一律当空对象（与旧 JS 的 `payload.x` 读取等价）。 */
export function objArg(v) {
    return v !== null && typeof v === 'object' ? v : {};
}
//# sourceMappingURL=deps.js.map
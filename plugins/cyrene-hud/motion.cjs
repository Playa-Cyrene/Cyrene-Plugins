"use strict";
const DETAIL_WIDTH = { cpu: 112, memory: 128, gpu: 152, network: 120, battery: 128, clock: 140, fan: 120 };
function measure(config) {
  const ring = Math.min(74, config.height - 12), padding = 14, start = padding + 44 + 16, gap = 12;
  const width = start + config.metrics.length * ring + (config.metrics.length - 1) * gap + padding;
  return { width, height: config.height, ring, padding, start, gap };
}
function compose(base, metrics, amounts, widths = DETAIL_WIDTH) {
  let offset = 0;
  const items = metrics.map((id, index) => {
    const amount = Math.max(0, amounts[id] || 0), x = base.start + index * (base.ring + base.gap) + offset;
    offset += amount;
    return { id, x, ringX: x, detailX: x + base.ring, amount, fullWidth: widths[id] };
  });
  return { width: base.width + offset, height: base.height, ring: base.ring, avatarX: base.padding, items };
}
function ease(value, transition, target, now) {
  if (value === target) return { value: target, transition: null };
  if (!transition || transition.target !== target) transition = { from: value, target, started: now };
  const progress = Math.max(0, Math.min(1, (now - transition.started) / 300));
  const amount = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
  return { value: progress === 1 ? target : transition.from + (target - transition.from) * amount, transition: progress === 1 ? null : transition };
}
module.exports = { DETAIL_WIDTH, measure, compose, ease };

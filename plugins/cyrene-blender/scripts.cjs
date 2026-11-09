'use strict';

function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的${integer ? '整数' : '数值'}。`);
  }
  return value;
}

// 数据先编码为 JSON 字符串，再由 Python 解码；名称和路径不会成为可执行代码。
function dataScript(data) {
  return `import bpy, json\nd = json.loads(${JSON.stringify(JSON.stringify(data))})\n`;
}

function resultScript(expression) {
  return `\nprint('CYRENE_RESULT=' + json.dumps(${expression}, ensure_ascii=False))\n`;
}

function parseResult(reply) {
  if (!reply.executed || reply.error || reply.traceback) throw new Error(reply.error || reply.traceback || 'Blender 没有确认操作已执行。');
  const line = String(reply.stdout || '').split(/\r?\n/).findLast(x => x.startsWith('CYRENE_RESULT='));
  if (!line) throw new Error('Blender 回执缺少结果，未将操作标记为成功。');
  return JSON.parse(line.slice(14));
}

function inspectScript() {
  return dataScript({}) + `s = bpy.context.scene
objects = list(s.objects)
result = {'name': s.name, 'filePath': bpy.data.filepath, 'object_count': len(objects), 'truncated': len(objects) > 500,
 'objects': [{'name': o.name, 'type': o.type, 'location': list(o.location), 'rotation': list(o.rotation_euler), 'rotationMode': o.rotation_mode, 'scale': list(o.scale)} for o in objects[:500]],
 'camera': s.camera.name if s.camera else None, 'frame': s.frame_current, 'frameStart': s.frame_start, 'frameEnd': s.frame_end,
 'fps': s.render.fps, 'resolution': [s.render.resolution_x, s.render.resolution_y], 'engine': s.render.engine}
` + resultScript('result');
}

function transformScript(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256) throw new Error('请提供有效的 Blender 物体名称。');
  const d = { name: input.name };
  for (const field of ['location', 'rotation', 'scale']) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].length !== 3) throw new Error(`${field} 需要三个数值。`);
    d[field] = input[field].map(x => number(x, field, field === 'scale' ? 0.0001 : -100000, 100000));
  }
  if (Object.keys(d).length === 1) throw new Error('至少提供位置、旋转或缩放中的一项。');
  return dataScript(d) + `o = bpy.context.scene.objects.get(d['name'])
if o is None: raise ValueError('找不到物体：' + d['name'])
if o.library and not o.override_library: raise ValueError('链接库物体不可直接修改')
if 'rotation' in d and o.rotation_mode in {'QUATERNION', 'AXIS_ANGLE'}: raise ValueError('此物体使用四元数或轴角旋转；首版仅支持欧拉旋转，位置和缩放仍可修改')
for key in ['location', 'rotation', 'scale']:
 if key in d: setattr(o, 'rotation_euler' if key == 'rotation' else key, d[key])
bpy.context.view_layer.update()
` + resultScript("{'name': o.name, 'location': list(o.location), 'rotation': list(o.rotation_euler), 'rotationMode': o.rotation_mode, 'scale': list(o.scale)}");
}

function snapshotScript(file, render = null) {
  return dataScript({ file, render }) + `s = bpy.context.scene
if d['render'] and not s.camera: raise ValueError('场景没有活动摄像机，请先在 Blender 中设置')
old_fps = s.render.fps
old_base = s.render.fps_base
try:
 if d['render']:
  s.render.fps = d['render']['fps']
  s.render.fps_base = 1.0
 bpy.ops.wm.save_as_mainfile(filepath=d['file'], copy=True, check_existing=False)
finally:
 s.render.fps = old_fps
 s.render.fps_base = old_base
` + resultScript("{'filePath': d['file'], 'sourcePath': bpy.data.filepath, 'resolution': [s.render.resolution_x, s.render.resolution_y], 'engine': s.render.engine, 'frame': s.frame_current}");
}

module.exports = { number, parseResult, inspectScript, transformScript, snapshotScript };

'use strict';

const { BlenderService } = require('./service.cjs');
const path = require('node:path');
let service;
let panelWindow;

function jsonSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

module.exports = {
  async open() {
    if (!service || service.closed) throw new Error('请先启用 Blender 工作台。');
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.show();
      panelWindow.focus();
      return;
    }
    // 原生插件窗口使用独立隔离 preload，供没有嵌入面板入口的宿主版本使用。
    const { BrowserWindow } = require('electron');
    const window = new BrowserWindow({
      title: 'Blender 工作台', width: 960, height: 900, minWidth: 600, minHeight: 650,
      autoHideMenuBar: true, backgroundColor: '#f8f7fa',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    panelWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('closed', () => { if (panelWindow === window) panelWindow = undefined; });
    await window.loadFile(path.join(__dirname, 'standalone.html'));
  },
  async register(ctx) {
    service = new BlenderService(ctx);
    const current = service;
    ctx.onDispose(() => current.dispose());
    ctx.onDispose(() => {
      if (panelWindow && !panelWindow.isDestroyed()) panelWindow.destroy();
      panelWindow = undefined;
    });
    const ipc = {
      'get-state': () => current.getState(),
      'get-preview': input => current.getPreview(input),
      'get-addon-token': () => current.getAddonToken(),
      'save-config': input => current.serial(() => current.saveConfig(input)),
      'start-gateway': () => current.serial(() => current.start()),
      'stop-gateway': () => current.stop(),
      refresh: () => current.serial(() => current.refresh()),
      'select-instance': input => current.serial(() => current.selectInstance(input)),
      'inspect-scene': () => current.serial(async () => { await current.inspect(); return current.getState(); }),
      'capture-preview': () => current.serial(async () => { await current.capture(); return current.getState(); }),
      'submit-render': input => current.serial(async () => { await current.render(input); return current.getState(); }),
      'cancel-job': input => current.cancelJob(input).then(() => current.getState()),
    };
    for (const [name, handler] of Object.entries(ipc)) ctx.registerIpc(name, handler);
    const vector = { type: 'array', items: { type: 'number' }, description: '三个有限数值；旋转单位为弧度。' };
    const definitions = [
      ['status', 'Blender 连接状态', '检查本机网关、扩展连接和当前任务；不会自动启动网关。', 'safe', 'read', jsonSchema(), () => current.refresh()],
      ['inspect', '读取 Blender 场景', '读取当前场景，最多返回500个物体及相机、帧率和分辨率；标记是否截断。', 'fs-read', 'read', jsonSchema(), (_, c) => current.inspect(c?.signal)],
      ['transform', '调整 Blender 物体', '按精确名称设置现有物体的本地位置、欧拉旋转或正缩放。只在用户要求调整场景时使用。', 'input-control', 'mutation', jsonSchema({ name: { type: 'string' }, location: vector, rotation: vector, scale: vector }, ['name']), (a, c) => current.transform(a, c?.signal)],
      ['preview', '截图 Blender 视口', '保存当前视口PNG并返回绝对路径，工作台可直接查看。仅在宿主权限允许时用Read分析；project-read-only只允许工作区内图片，读取被拒绝时须说明限制。', 'fs-write', 'verification', jsonSchema(), (_, c) => current.capture(c?.signal)],
      ['save_copy', '保存 Blender 副本', '将当前场景保存为输出目录中的独立blend副本，保持原工程路径。', 'fs-write', 'mutation', jsonSchema(), (_, c) => current.saveCopy(c?.signal)],
      ['render', '提交 Blender 渲染', '保存独立副本并启动后台渲染，立即返回任务ID。输出PNG序列，单次最多3600帧，实际运行最长1小时，超时终止；默认保留工程帧率和分辨率比例。后台使用出厂偏好，不加载用户插件或GPU设备偏好；不会自动拼接视频。', 'fs-write', 'mutation', jsonSchema({ kind: { type: 'string', enum: ['still', 'animation'] }, frameStart: { type: 'integer' }, frameEnd: { type: 'integer' }, fps: { type: 'integer', minimum: 1, maximum: 120, description: '省略时保留工程帧率及分数基数；显式设置时使用整数帧率。' }, resolutionPercentage: { type: 'integer', minimum: 1, maximum: 100, description: '省略时保留工程的分辨率百分比。' } }, ['kind']), (a, c) => current.render(a, c?.signal)],
      ['job_status', '查看 Blender 渲染任务', '通过本插件返回的任务ID查询进度和输出文件。', 'safe', 'read', jsonSchema({ id: { type: 'string' } }, ['id']), (a, c) => current.jobStatus(a.id, c?.signal)],
      ['cancel_job', '取消 Blender 渲染任务', '取消本插件创建的指定渲染任务。已完成的任务保持完成状态。', 'input-control', 'mutation', jsonSchema({ id: { type: 'string' } }, ['id']), (a, c) => current.cancelJob(a, c?.signal)],
    ];
    for (const [id, name, description, risk, effectKind, inputSchema, execute] of definitions) {
      ctx.registerTool({
        id: `cyrene-blender_${id}`, name, description, inputSchema,
        enabled: true, risk, effectKind, verificationPolicy: effectKind === 'read' ? 'none' : 'artifact',
        needsContext: true, modes: ['learn', 'code', 'work'], ledgerPolicy: 'bypass',
        async execute(args, context) {
          const operation = () => execute(args, context);
          const value = id === 'cancel_job' ? await operation() : await current.serial(operation, context?.signal);
          return JSON.stringify(value);
        },
      });
    }
    ctx.registerPromptProvider({
      id: 'blender-workbench', modes: ['learn', 'code', 'work'],
      provide: () => 'Blender工作台：先检查status，再读取真实场景。只修改用户指定物体，不猜物体名。预览在工作台展示；仅在宿主权限允许读取返回路径时用Read分析。project-read-only只允许工作区内文件，私有输出目录可能无法读取，应告知用户将输出目录设置到工作区内或在工作台查看，不可声称已看图。渲染最多3600帧且实际运行最长1小时，保留工程默认帧率和分辨率比例，但不加载用户插件或GPU偏好。render返回任务ID不代表完成，请查询job_status并检查artifacts。网关需用户在插件面板启动；首版单实例，不支持任意Python、自动建模或直接视频输出。',
    });
  },
  async unregister() {
    if (service) await service.dispose();
    service = undefined;
  },
};

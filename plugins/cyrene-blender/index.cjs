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
      ['preview', '截图 Blender 视口', '保存当前视口PNG并返回绝对路径。需要图像分析时继续使用Read工具读取该图片。', 'fs-write', 'verification', jsonSchema(), (_, c) => current.capture(c?.signal)],
      ['save_copy', '保存 Blender 副本', '将当前场景保存为输出目录中的独立blend副本，保持原工程路径。', 'fs-write', 'mutation', jsonSchema(), (_, c) => current.saveCopy(c?.signal)],
      ['render', '提交 Blender 渲染', '保存独立副本并启动后台渲染，立即返回任务ID。输出PNG序列，单次最多3600帧；不会自动拼接视频。', 'fs-write', 'mutation', jsonSchema({ kind: { type: 'string', enum: ['still', 'animation'] }, frameStart: { type: 'integer' }, frameEnd: { type: 'integer' }, fps: { type: 'integer' }, resolutionPercentage: { type: 'integer' } }, ['kind']), (a, c) => current.render(a, c?.signal)],
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
          // 面板图片独立展示，避免将大段base64塞入模型上下文。
          if (id === 'status' && value.preview) value.preview = { filePath: value.preview.filePath, capturedAt: value.preview.capturedAt };
          return JSON.stringify(value);
        },
      });
    }
    ctx.registerPromptProvider({
      id: 'blender-workbench', modes: ['learn', 'code', 'work'],
      provide: () => 'Blender工作台：先检查status，再读取真实场景。只修改用户指定物体，不猜物体名。预览返回图片路径，可用Read分析。render返回任务ID不代表完成，请查询job_status并检查artifacts。网关需用户在插件面板启动；首版单实例，不支持任意Python、自动建模或直接视频输出。',
    });
  },
  async unregister() {
    if (service) await service.dispose();
    service = undefined;
  },
};

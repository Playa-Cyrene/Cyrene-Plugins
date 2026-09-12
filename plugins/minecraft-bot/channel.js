"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinecraftChannelAdapter = void 0;
/** 原版聊天单条长度上限（超长会被服务器拒绝）。 */
const GAME_CHAT_LINE_LIMIT = 256;
/** 多行回复逐条发送的间隔，避免触发服务器刷屏保护。 */
const LINE_SEND_INTERVAL_MS = 350;
const CAPABILITY = {
    text: true,
    image: false,
    audio: false,
    file: false,
    video: false,
    markdown: false,
    card: false,
    sticker: false,
    maxTextLength: GAME_CHAT_LINE_LIMIT,
};
class MinecraftChannelAdapter {
    bridge;
    id = "minecraft";
    displayName = "Minecraft";
    capability = CAPABILITY;
    onMessage = null;
    /** 退订函数集合；stop() 时统一清理。 */
    unsubs = [];
    constructor(bridge) {
        this.bridge = bridge;
    }
    async start() {
        // 订阅游戏聊天：玩家发言 → 归一化 → 交给宿主调度器跑一轮 Agent
        this.unsubs.push(this.bridge.onChat((player, message) => void this.handleGameChat(player, message)));
        // 状态订阅仅为让宿主感知连接变化（日志层面），无需额外处理
        this.unsubs.push(this.bridge.onStateChange((state) => {
            if (state === "connected") {
                // 连接建立后频道即活；无需通知，getStatus() 是轮询式
            }
        }));
    }
    async stop() {
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
    }
    /** 玩家发言转宿主入站消息；onMessage 的返回值由调度器负责投递，这里不重发。 */
    async handleGameChat(player, message) {
        if (!this.onMessage)
            return;
        const status = this.bridge.status();
        const inMsg = {
            channel: this.id,
            // 游戏聊天本质是所有人共享的公共频道
            chatType: "group",
            messageId: `mc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            senderId: player,
            senderName: player,
            chatId: status.host ? `${status.host}:${status.port ?? 25565}` : "minecraft-server",
            text: message,
            at: new Date(),
        };
        try {
            await this.onMessage(inMsg);
        }
        catch (err) {
            // 调度器内部已记日志；这里兜底防异常冒泡到 bridge 的事件循环
            console.error("[minecraft-channel] 调度器处理消息失败:", err);
        }
    }
    /** 出站：把统一消息的文本部分按行拆开，让机器人逐条在游戏里发言。 */
    async send(message) {
        if (this.bridge.status().state !== "connected") {
            return { ok: false, error: "机器人未连接服务器" };
        }
        const text = message.parts
            .filter((p) => p.kind === "text" && typeof p.text === "string")
            .map((p) => String(p.text))
            .join("\n");
        const lines = text
            .split("\n")
            .map((l) => l.trim().slice(0, GAME_CHAT_LINE_LIMIT))
            .filter((l) => l.length > 0);
        if (lines.length === 0)
            return { ok: true };
        try {
            for (let i = 0; i < lines.length; i++) {
                if (i > 0)
                    await new Promise((r) => setTimeout(r, LINE_SEND_INTERVAL_MS));
                this.bridge.say(lines[i]);
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    getStatus() {
        const status = this.bridge.status();
        if (status.state === "connected") {
            return {
                enabled: true,
                phase: "running",
                message: `已连接 ${status.host}:${status.port}（${status.username}）`,
            };
        }
        if (status.state === "connecting")
            return { enabled: true, phase: "starting", message: "正在连接服务器" };
        return { enabled: true, phase: "offline", message: "机器人未连接，用连接工具接入服务器后频道自动生效" };
    }
}
exports.MinecraftChannelAdapter = MinecraftChannelAdapter;

/**
 * rooms —— Room 注册表与帧队列（播放状态机的主进程侧）。
 *
 * 设计依据：DESIGN.md §7。一节课 = 一个 Room：帧队列（栈）+ 黑板 + 已推过的剧本文件清单。
 *
 * 队列即栈：**frames[0] 就是正在播放的那一帧**，所以"打断压栈"和"恢复弹栈"
 * 统一成对队首的插入/移除，只有一种数据结构要维护。
 *
 * 权威状态在主进程：`advance()` 既推进指针，也**顺带算出这一步之后的板书**，
 * 一并返回给窗口渲染。这样窗口不需要自己维护黑板，Provider 也能读到准确的板书全文。
 */
const board = require("./board.cjs");

/** key = conversationId。一个插件实例服务所有会话，绝不能共用帧队列或黑板（§5.3 第 9 条）。 */
const rooms = new Map();

/** 帧队列上限（§7.3 第 4 条）。约 3 层 + 过渡帧。 */
const MAX_FRAMES = 9;

function createRoom(conversationId) {
  return {
    conversationId,
    frames: [], // 待播放队列；frames[0] 是当前正在播放的帧
    nextPushOrder: 0, // 同一房间内的推入顺序；超限时据此淘汰较早的待播层
    board: board.createBoard(),
    boardOwner: null, // 当前 room.board 反映的是哪一层的增量；null = 空板
    lessonFiles: [], // 本节课推过的剧本文件，按推送顺序 —— 回放的播放列表
    lessonPaths: {}, // 文件名 → 绝对路径。只记"用户从文件选择器里挑过"的那些（§14g）
    review: { layerId: null, file: "", says: [] }, // 当前已展示 BLS 的对白快照
    clearEpoch: 0, // 使清空前已启动的异步回放失效；只在本次运行中使用
    updatedAt: Date.now(),
  };
}

function getRoom(conversationId) {
  if (!conversationId) return null;
  return rooms.get(conversationId) || null;
}

function ensureRoom(conversationId) {
  const existing = getRoom(conversationId);
  if (existing) return existing;
  const room = createRoom(conversationId);
  rooms.set(conversationId, room);
  return room;
}

function dropRoom(conversationId) {
  return rooms.delete(conversationId);
}

function allRooms() {
  return Array.from(rooms.values());
}

/** 当前正在播放的层（frames[0] 是 layer 帧时），否则 null。 */
function activeLayer(room) {
  if (!room || !room.frames.length) return null;
  const head = room.frames[0];
  return head && head.type === "layer" ? head.layer : null;
}

/**
 * 用已解析好的 steps 装出一层。
 * boardOps 在这里投影，保证校验器、播放器、断点重绘器共用同一份 apply()（§4.4 / §8.3）。
 */
function makeLayer(input) {
  return {
    id: input.id,
    runId: input.runId || "",
    conversationId: input.conversationId,
    index: input.index || 0,
    file: input.file,
    title: input.title || "",
    steps: input.steps,
    cursor: 0,
    boardOps: board.projectBoardOps(input.steps),
    transitionHint: input.transitionHint || "",
  };
}

/** 构造一个过渡帧。过渡帧由窗口本地合成，不由模型产出（§6.2）。 */
function makeTransition(kind, text, title) {
  return { type: "transition", kind, text: text || "", title: title || "" };
}

/** 返回上一层的过渡文案可由模型指定；进入新层时使用默认话术。 */
function transitionText(kind, hint) {
  if (hint) return String(hint);
  return kind === "out" ? "好，我们回到刚才那里。" : "先看一个补充。";
}

/**
 * 帧队列超限时，丢弃最早推入的非队首层（连带它后面的过渡帧）。
 * interrupt 在队首插入、append 在队尾插入，因此不能用队列位置判断新旧。
 * @returns {number} 丢弃的层数
 */
function enforceFrameBudget(room, limit = MAX_FRAMES) {
  let dropped = 0;
  while (room.frames.length > limit) {
    let idx = -1;
    let oldestOrder = Infinity;
    for (let i = 1; i < room.frames.length; i += 1) {
      const frame = room.frames[i];
      if (frame.type !== "layer") continue;
      const order = Number.isSafeInteger(frame.pushOrder) ? frame.pushOrder : 0;
      if (order < oldestOrder) {
        idx = i;
        oldestOrder = order;
      }
    }
    if (idx < 0) {
      // 只剩过渡帧，直接截断
      room.frames.length = limit;
      break;
    }
    let end = idx + 1;
    const after = room.frames[end];
    if (after && after.type === "transition" && after.kind === "out") end += 1;
    room.frames.splice(idx, end - idx);
    dropped += 1;
  }
  return dropped;
}

/**
 * 推入一层新剧本（§7.4）。
 *
 * interrupt（默认）：冻结当前层 cursor → 在最前面插一个 transition(in) → 新层插到它后面。
 *   之所以只在 frames[0] 是 layer 时才插过渡帧：队首已经是过渡帧时，再插一个会出现
 *   连续两帧过渡，而"最新的打断优先"本来就该直接顶到那个过渡帧之后。
 * append：新层排到队尾，不动当前播放。
 *
 * @param {number} [maxFrames] 本次入队允许的队列上限。默认 MAX_FRAMES。
 *   回放整节课时会放宽到播放列表长度，因为那个上限本来是防"插话越积越深"的（§14b）。
 * @returns {{ frameCount: number, dropped: number }}
 */
function pushLayer(room, layer, mode, maxFrames) {
  const interrupt = mode !== "append";
  const head = room.frames[0];
  const frame = { type: "layer", layer, pushOrder: ++room.nextPushOrder };

  if (interrupt && head && head.type === "layer") {
    // cursor 一直在 layer 对象上，不需要额外快照
    room.frames.unshift(makeTransition("in", transitionText("in", "")));
    room.frames.splice(1, 0, frame);
  } else if (interrupt && head) {
    room.frames.splice(1, 0, frame);
  } else {
    room.frames.push(frame);
  }

  if (layer.file && !room.lessonFiles.includes(layer.file)) room.lessonFiles.push(layer.file);

  const dropped = enforceFrameBudget(room, maxFrames);
  room.updatedAt = Date.now();
  return { frameCount: room.frames.length, dropped };
}

/**
 * 把帧队列与黑板一起清回"还没开讲"的状态。回放的前置动作（§14）。
 *
 * 刻意**不插前置过渡帧**：过渡帧的职责是"打断 / 回到被打断的那一层"要有个交代（§7.4），
 * 而回放是用户自己按的按钮——他已经知道点了什么，再让他点一次"过渡"是多余的一步，
 * 而且窗口在按下按钮时已经立刻清板并弹了提示，视觉反馈由那一步给足。
 *
 * 层与层之间的过渡帧仍然由 advance 在每层结束时补（§7.3），所以分节演出的节奏不变。
 */
function resetForReplay(room) {
  room.frames = [];
  room.board = board.createBoard();
  room.boardOwner = null;
  room.review = { layerId: null, file: "", says: [] };
  room.updatedAt = Date.now();
  return 0;
}

/** 清空当前课堂的播放现场和回放索引，磁盘上的剧本文件不受影响。 */
function clearRoom(room) {
  resetForReplay(room);
  room.lessonFiles = [];
  room.lessonPaths = {};
  room.restoreNotice = "";
  room.clearEpoch += 1;
}

/**
 * 重放一层（§14a）：清空队列与黑板，把这一层重新排到队首。
 *
 * 不是"再推一份同样的剧本" —— 那样旧的那层还留在队列里，重放完会把用户丢回旧进度。
 */
function replayLayer(room, layer) {
  resetForReplay(room);
  room.frames.push({ type: "layer", layer, pushOrder: ++room.nextPushOrder });
  // 播放列表语义：重放本课程里的某一节 → 保留整条列表（"从头"仍能放完整节课）；
  // 放一个不属于当前课程的剧本（用户从选择器里挑了别的课）→ 视为开始新的一节，列表换成它自己。
  if (layer.file && !room.lessonFiles.includes(layer.file)) room.lessonFiles = [layer.file];
  return { frameCount: room.frames.length, dropped: 0 };
}

/**
 * 从头重放整节课（§14b）：清空队列与黑板，按播放列表依次排入。
 *
 * 队列上限在这里放宽到"播放列表长度 + 1"：那个上限是防插话堆积的，
 * 而回放是用户主动要的一条完整播放列表，不该被裁掉。
 */
function replayAll(room, layers) {
  resetForReplay(room);
  room.lessonFiles = [];
  const budget = layers.length + 2;
  let dropped = 0;
  for (const layer of layers) {
    dropped += pushLayer(room, layer, "append", budget).dropped;
  }
  return { frameCount: room.frames.length, dropped };
}

/** 当前屏幕所处 BLS 的 say。切回旧层时从断点前重建，不混入插话层。 */
function recordDisplayedStep(room, layer, stepIndex) {
  if (room.review.layerId !== layer.id) {
    room.review = {
      layerId: layer.id,
      file: layer.file,
      says: layer.steps.slice(0, stepIndex)
        .filter((step) => step.kind === "say")
        .map((step) => step.text),
    };
  }
  const step = layer.steps[stepIndex];
  if (step.kind === "say") room.review.says.push(step.text);
}

/**
 * 用户点击推进一帧（§7.3）。
 *
 * 过渡帧是**需要点击的帧**：它要展示清板动作与过渡文案，所以不能在同一次点击里被
 * 连带消费掉，否则文案根本来不及被看见。
 *
 * @returns {{ kind: "step", step: object, stepIndex: number, file: string, cursor: number,
 *             total: number, boardText: string, layerFinished: boolean }
 *          | { kind: "transition", transition: object, boardText: string }
 *          | { kind: "done", boardText: string }}
 */
function advance(room) {
  for (;;) {
    if (!room.frames.length) {
      return { kind: "done", boardText: board.boardText(room.board) };
    }

    const head = room.frames[0];

    if (head.type === "transition") {
      room.frames.shift();
      // 过渡帧负责清板（§7.4）：用户在这一次点击里看到的是"擦干净的黑板 + 过渡文案"。
      // 被打断那一层的板书**不在这里**重绘 —— 留到下一次点击真正要演它的步时再瞬时重绘，
      // 否则清板和重绘发生在同一帧，用户根本看不到擦板动作。
      room.board = board.createBoard();
      room.boardOwner = null;
      room.updatedAt = Date.now();
      return {
        kind: "transition",
        transition: { kind: head.kind, text: head.text, title: head.title },
        boardText: "",
      };
    }

    const layer = head.layer;
    if (layer.cursor >= layer.steps.length) {
      // 本层结束：弹出；还有后续层就用本层保留的 hint 生成 transition(out)
      room.frames.shift();
      if (room.frames.length) {
        room.frames.unshift(makeTransition("out", transitionText("out", layer.transitionHint)));
      }
      continue;
    }

    const step = layer.steps[layer.cursor];
    // 恢复到某一层（插话结束回来、或回放跳到某节）时，先按断点把它的板瞬时重绘出来（§8.3）。
    // 必须在 cursor++ 之前做：此时 cursor 指向"即将演的那一步"，重放 [0, cursor) 才是正确的前置状态。
    const needsRebuild = room.boardOwner !== layer.id;
    if (needsRebuild) {
      rebuildBoardAt(room, layer);
    }
    // 窗口刚演过清板过渡帧时，还显示着空板。把本步之前的断点板书也交给它，
    // 让窗口先瞬时铺回旧板，再演当前 step（当前步可能只是 say，不会主动渲染黑板）。
    const boardTextBeforeStep = needsRebuild ? board.boardText(room.board) : null;
    layer.cursor += 1;
    board.apply(step, room.board); // say 不动黑板，返回 false 是正常情况
    recordDisplayedStep(room, layer, layer.cursor - 1);
    room.updatedAt = Date.now();

    return {
      kind: "step",
      step,
      stepIndex: layer.cursor - 1,
      file: layer.file,
      cursor: layer.cursor,
      total: layer.steps.length,
      boardTextBeforeStep,
      boardText: board.boardText(room.board),
      layerFinished: layer.cursor >= layer.steps.length,
    };
  }
}

/** 断点重绘用的黑板重建（§8.3）：清空后按 boardOps 重放到 cursor。每层从空板开始。 */
function rebuildBoardAt(room, layer) {
  const draft = board.createBoard();
  for (const op of layer.boardOps) {
    if (op.stepIndex < layer.cursor) board.apply(op, draft);
  }
  room.board = draft;
  room.boardOwner = layer.id;
  return draft;
}

// ---------------------------------------------------------------- 持久化（§13）

/** 只保留最近（按 updatedAt）这么多个会话。 */
const PERSIST_ROOM_LIMIT = 3;
/** 每个会话最多存这么多层（从队首数），更深的层连同其后的过渡帧一起截掉。 */
const PERSIST_LAYER_LIMIT = 3;

/**
 * 一个房间 → 可写进 storage 的纯数据。
 *
 * 存帧的文件名 + cursor + 过渡文案（§13）。`steps` 与 `boardOps`
 * 一律不存——它们只是文件内容的投影，读盘重新解析即可；存下来反而可能与磁盘上的剧本不一致。
 *
 * 黑板存**行数组**（而不是让窗口等到第一次点击才重绘）：重开窗口时要立刻看到"回到刚才那块板"。
 * `lessonPaths` 也一并存：用户从文件选择器挑的剧本在工作区外，不存路径就重读不到它（§14g）。
 * `review` 存当前已展示 BLS 的 say 快照；过渡帧和课程结束后也能回看当时说过的话。
 */
function serializeRoom(room) {
  const frames = [];
  let layers = 0;
  for (const frame of room.frames) {
    if (frame.type !== "layer") {
      frames.push({ type: "transition", kind: frame.kind, text: frame.text, title: frame.title || "" });
      continue;
    }
    if (layers >= PERSIST_LAYER_LIMIT) break; // 更深的层连同它后面的过渡帧一起不要
    layers += 1;
    frames.push({
      type: "layer",
      file: frame.layer.file,
      cursor: frame.layer.cursor,
      transitionHint: frame.layer.transitionHint || "",
      pushOrder: frame.pushOrder,
    });
  }
  return {
    frames,
    board: room.board.lines.slice(),
    lessonFiles: room.lessonFiles.slice(),
    lessonPaths: Object.assign({}, room.lessonPaths),
    review: { file: room.review.file, says: room.review.says.slice() },
    updatedAt: room.updatedAt,
  };
}

/** 全部房间 → storage 形态。没帧、剧本索引和回看内容的空房间不存。 */
function serializeRooms(limit = PERSIST_ROOM_LIMIT) {
  const picked = Array.from(rooms.values())
    .filter((room) => room.frames.length > 0 || room.lessonFiles.length > 0 || room.review.says.length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit);
  const out = {};
  for (const room of picked) out[room.conversationId] = serializeRoom(room);
  return out;
}

/**
 * 从持久化快照重建房间（§13）。读盘与解析由调用方注入（`resolveLayer`），
 * 这样 rooms.cjs 不必知道工作区与 BLS。
 *
 * @param {object} snapshot storage 里的 rooms
 * @param {(room: object, entry: object, index: number) => (object|null)} resolveLayer
 *        按文件造层；读不到就返回 null，该帧丢弃
 * @returns {{ restored: number, missed: string[] }}
 */
function restoreRooms(snapshot, resolveLayer) {
  const missed = [];
  let restored = 0;
  if (!snapshot || typeof snapshot !== "object") return { restored, missed };

  for (const [conversationId, state] of Object.entries(snapshot)) {
    if (!conversationId || !state || typeof state !== "object") continue;

    const room = createRoom(conversationId);
    room.lessonFiles = Array.isArray(state.lessonFiles) ? state.lessonFiles.slice() : [];
    room.lessonPaths =
      state.lessonPaths && typeof state.lessonPaths === "object" ? Object.assign({}, state.lessonPaths) : {};
    if (state.review && typeof state.review === "object") {
      room.review.file = typeof state.review.file === "string" ? state.review.file : "";
      room.review.says = Array.isArray(state.review.says)
        ? state.review.says.filter((text) => typeof text === "string").slice(0, 200)
        : [];
    }
    room.updatedAt = Number(state.updatedAt) || Date.now();
    if (Array.isArray(state.board)) room.board = { lines: state.board.slice() };

    const lost = [];
    const frames = Array.isArray(state.frames) ? state.frames : [];
    frames.forEach((entry, index) => {
      if (!entry || entry.type === "transition") {
        room.frames.push(
          makeTransition(
            entry && entry.kind === "out" ? "out" : "in",
            (entry && entry.text) || "",
            (entry && entry.title) || "",
          ),
        );
        return;
      }
      const layer = resolveLayer(room, entry, index);
      if (!layer) {
        lost.push(String((entry && entry.file) || `第 ${index + 1} 节`));
        return;
      }
      // cursor 越界（剧本被改短了）时夹回合法范围，别让第一次点击就判"本层结束"
      const cursor = Number(entry.cursor) || 0;
      layer.cursor = Math.max(0, Math.min(cursor, layer.steps.length));
      if (entry.transitionHint) layer.transitionHint = String(entry.transitionHint);
      // 旧快照没有 pushOrder，用 lessonFiles 的首次推送顺序近似恢复；
      // 同一文件被重复推送时无法区分先后，但新推的层仍会排在旧帧之后。
      const legacyIndex = room.lessonFiles.indexOf(layer.file);
      const pushOrder = Number.isSafeInteger(entry.pushOrder) && entry.pushOrder > 0
        ? entry.pushOrder : Math.max(0, legacyIndex + 1);
      room.nextPushOrder = Math.max(room.nextPushOrder, pushOrder);
      room.frames.push({ type: "layer", layer, pushOrder });
    });

    if (lost.length) {
      room.restoreNotice = `重开课堂时发现 ${lost.length} 节剧本文件已丢失（${lost.join("、")}），已跳过。`;
      lost.forEach((name) => missed.push(`${conversationId}/${name}`));
    }

    // 快照里的板书可能属于刚播完的旧层，而队首已是尚未点击的新层。
    // 队首是 layer 时，按重新解析出的板书操作重建到 cursor，保证首次还原的画面
    // 与后续 advance() 使用的是同一层的板书；过渡帧仍保留快照画面直到点击清板。
    const head = room.frames[0];
    if (head && head.type === "layer") rebuildBoardAt(room, head.layer);
    else room.boardOwner = null;
    if (!state.review && head && head.type === "layer" && head.layer.cursor > 0) {
      // 升级旧存档：那时还没有 review 字段，能从当前层的断点补出已展示的对白。
      room.review.file = head.layer.file;
      room.review.says = head.layer.steps.slice(0, head.layer.cursor)
        .filter((step) => step.kind === "say")
        .map((step) => step.text);
    }

    rooms.set(conversationId, room);
    restored += 1;
  }
  return { restored, missed };
}

/**
 * 把一间房间改挂到另一个 conversationId 上。
 *
 * 用途见 index.cjs 的 `resolvePushRoom`：模型在某个会话里插话时，若那间会话还没有自己的教室，
 * 而窗口正看着另一间有内容的教室（最典型是「📂 打开剧本」挑来的 `local` 房间），
 * 就把现成这间认作该会话的教室，而不是另起一间空的。房间对象本身不动，只换 key。
 *
 * **会覆盖目标 key 上原有的房间** —— 调用方必须先确认那边是空房间，否则会吞掉内容。
 */
function renameRoom(room, conversationId) {
  if (!room || !conversationId || room.conversationId === conversationId) return room;
  rooms.delete(room.conversationId);
  room.conversationId = conversationId;
  room.updatedAt = Date.now();
  rooms.set(conversationId, room);
  return room;
}

function clearAll() {
  rooms.clear();
}

module.exports = {
  MAX_FRAMES,
  getRoom,
  ensureRoom,
  dropRoom,
  allRooms,
  activeLayer,
  makeLayer,
  makeTransition,
  transitionText,
  pushLayer,
  replayLayer,
  replayAll,
  resetForReplay,
  clearRoom,
  advance,
  rebuildBoardAt,
  enforceFrameBudget,
  serializeRoom,
  serializeRooms,
  restoreRooms,
  renameRoom,
  clearAll,
};

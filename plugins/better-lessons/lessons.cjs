/**
 * lessons —— 工作区 learn/lessons/ 下的剧本文件 IO。
 *
 * 这是插件在工作区里**唯一**的写入面（DESIGN.md §10），
 * 也是唯一的路径安全边界（§5.3 第 3 条）。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 相对工作区根的子目录（§4.6）。 */
const LESSONS_SUBDIR = path.join("learn", "lessons");
/** 剧本文件扩展名。刻意不用 .md —— Obsidian 会把 `>>` 当引用渲染，文件看起来像坏了。 */
const LESSON_EXT = ".bls";
/** 裸文件名白名单：不含任何路径分隔符（§4.6）。 */
const FILE_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,48}\.bls$/;
/** 单文件上限（§4.6）。 */
const MAX_BYTES = 64 * 1024;

function lessonsDir(workspaceRoot) {
  return path.join(workspaceRoot, LESSONS_SUBDIR);
}

/**
 * 把模型给的文件名解析成绝对路径。
 *
 * 名字直接来自模型，而插件有完整 fs 权限，所以这里必须硬校验：
 * 白名单正则 + 不以点开头 + resolve 后仍在 learn/lessons/ 之内。
 */
function resolveLessonPath(workspaceRoot, file) {
  if (!workspaceRoot) throw new Error("该会话未绑定工作区，无法读写剧本文件");
  const name = String(file == null ? "" : file).trim();
  if (!name) throw new Error("缺少文件名 file");
  if (name.startsWith(".")) throw new Error(`文件名不能以点开头：${name}`);
  if (!FILE_RE.test(name)) {
    throw new Error(`文件名非法：${name}（需匹配 ${FILE_RE} 且以 ${LESSON_EXT} 结尾）`);
  }
  const dir = path.resolve(lessonsDir(workspaceRoot));
  const target = path.resolve(dir, name);
  if (target !== path.join(dir, name)) throw new Error(`文件名越界：${name}`);
  return target;
}

/** 目录不存在就建。宿主 vault 初始化里没有 learn/lessons/，插件自己补。 */
function ensureLessonsDir(workspaceRoot) {
  const dir = lessonsDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** learn/lessons/ 是否已存在。给文件选择器挑默认位置用，不创建目录。 */
function hasLessonsDir(workspaceRoot) {
  return Boolean(workspaceRoot) && fs.existsSync(lessonsDir(workspaceRoot));
}

/** 两种读取入口共用：先确认是普通文件且不超限，再同步读取正文。 */
function readValidatedLessonFile(target) {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("剧本不是普通文件");
  if (stat.size > MAX_BYTES) throw new Error(`剧本超过 ${MAX_BYTES} 字节上限`);
  return fs.readFileSync(target, "utf8");
}

/**
 * 读一个**用户从文件选择器里挑的**剧本：绝对路径，不走白名单。
 *
 * 这里不做路径校验是刻意的：路径来自用户本人在系统对话框里的选择，不是模型给的；
 * 而且这个通道只挂在窗口的 IPC 上，不是工具，模型碰不到它（模型那条路仍走 readLesson 的白名单）。
 */
function readLessonByPath(filePath) {
  const target = path.resolve(String(filePath == null ? "" : filePath));
  return readValidatedLessonFile(target);
}

function lessonExists(workspaceRoot, file) {
  return fs.existsSync(resolveLessonPath(workspaceRoot, file));
}

/** 读剧本正文。文件不存在时抛 ENOENT，由调用方翻译成可行动的文案。 */
function readLesson(workspaceRoot, file) {
  return readValidatedLessonFile(resolveLessonPath(workspaceRoot, file));
}

/**
 * 写剧本正文（同名覆盖）。UTF-8、无 BOM、\n 换行。
 * 返回 { file, path, bytes, overwritten }。
 */
function writeLesson(workspaceRoot, file, text) {
  const target = resolveLessonPath(workspaceRoot, file);
  const body = String(text == null ? "" : text);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`剧本超过 ${MAX_BYTES} 字节上限（当前 ${bytes}）`);
  ensureLessonsDir(workspaceRoot);
  const overwritten = fs.existsSync(target);
  fs.writeFileSync(target, body, { encoding: "utf8" });
  return { file: path.basename(target), path: target, bytes, overwritten };
}

function deleteLesson(workspaceRoot, file) {
  const target = resolveLessonPath(workspaceRoot, file);
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  return true;
}

/** 列出目录下的剧本文件名，已排序。目录不存在时返回空数组。 */
function listLessons(workspaceRoot) {
  if (!workspaceRoot) return [];
  const dir = lessonsDir(workspaceRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(LESSON_EXT))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

module.exports = {
  LESSONS_SUBDIR,
  LESSON_EXT,
  FILE_RE,
  MAX_BYTES,
  lessonsDir,
  resolveLessonPath,
  ensureLessonsDir,
  hasLessonsDir,
  lessonExists,
  readLesson,
  readLessonByPath,
  writeLesson,
  deleteLesson,
  listLessons,
};

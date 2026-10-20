"use strict";

/**
 * 纯 JS PNG 编码器。
 *
 * 为什么不引第三方库：
 *   插件 zip 有体积限制，而 PNG 编码本身只需要 zlib（Node 内置）。
 *   这里只实现 32 位 RGBA + 无滤波，足够画地形图和高度图。
 *
 * 移植自 whale-craft 的同名实现思路（纯 JS，无 sharp 依赖）。
 */

const zlib = require("node:zlib");

/** PNG 签名 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32 表，模块加载时算一次 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 组一个 PNG chunk：长度 + 类型 + 数据 + CRC */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * 把 RGBA 像素数组编码成 PNG。
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  长度必须是 width * height * 4
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`PNG 尺寸非法：${width} x ${height}`);
  }

  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`像素数据长度不对：期望 ${expected}，实际 ${rgba.length}`);
  }

  // IHDR：宽、高、位深 8、颜色类型 6（RGBA）、压缩 0、滤波 0、隔行 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // 每行前面要加一个滤波类型字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 一个极简的画布：只支持填色和描点，够画地图用 */
class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** 填充整个画布 */
  fill(r, g, b, a = 255) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
    return this;
  }

  /** 画一个像素 */
  setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return this;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
    return this;
  }

  /** 填一个矩形 */
  fillRect(x, y, w, h, r, g, b, a = 255) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.setPixel(x + dx, y + dy, r, g, b, a);
      }
    }
    return this;
  }

  /** 画一个空心矩形（做格子线） */
  strokeRect(x, y, w, h, r, g, b, a = 255) {
    for (let dx = 0; dx < w; dx++) {
      this.setPixel(x + dx, y, r, g, b, a);
      this.setPixel(x + dx, y + h - 1, r, g, b, a);
    }
    for (let dy = 0; dy < h; dy++) {
      this.setPixel(x, y + dy, r, g, b, a);
      this.setPixel(x + w - 1, y + dy, r, g, b, a);
    }
    return this;
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}

module.exports = { encodePng, Canvas, crc32 };

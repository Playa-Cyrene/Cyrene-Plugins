"use strict";

/**
 * 局域网 Minecraft 服务器探测。
 *
 * 原理就是原版客户端那一件事：开了「对局域网开放」的服务器会周期性往
 * 多播地址 224.0.2.60:4445 发 `[MOTD]...[/MOTD][AD]端口[/AD]`。
 *
 * 这里只「听」不发：不扫端口、不发探测包，所以恒定在 seconds 内返回，
 * 没有广播的网络（部分 WiFi / VPN / 容器）就是听不到，属于正常现象。
 */

const dgram = require("node:dgram");

const MULTICAST_ADDR = "224.0.2.60";
const MULTICAST_PORT = 4445;

/**
 * @param {object} opts
 * @param {number} opts.seconds 听多久，默认 3
 * @returns {Promise<Array<{host:string,port:number,motd:string}>>}
 */
function listenLanBroadcast(opts = {}) {
  const seconds = Math.max(1, Math.min(Number(opts.seconds) || 3, 15));

  return new Promise((resolve) => {
    const found = [];
    const seen = new Set();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* 已经关了 */
      }
      resolve(found);
    };

    const timer = setTimeout(finish, seconds * 1000);
    if (timer.unref) timer.unref();

    socket.on("error", () => {
      // 多播在某些网络/权限下会直接失败，当作「没听到」处理
      clearTimeout(timer);
      finish();
    });

    socket.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8");
      const motdMatch = text.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/i);
      const adMatch = text.match(/\[AD\]([\s\S]*?)\[\/AD\]/i);

      const port = adMatch ? Number(adMatch[1]) : MULTICAST_PORT;
      if (!Number.isFinite(port) || port <= 0) return;

      const key = `${rinfo.address}:${port}`;
      if (seen.has(key)) return;
      seen.add(key);

      found.push({
        host: rinfo.address,
        port,
        motd: motdMatch ? motdMatch[1].trim() : null,
      });
    });

    socket.bind(MULTICAST_PORT, () => {
      try {
        socket.addMembership(MULTICAST_ADDR);
      } catch {
        // 加不进多播组就听不到，等超时正常返回空
      }
    });
  });
}

module.exports = { listenLanBroadcast, MULTICAST_ADDR, MULTICAST_PORT };

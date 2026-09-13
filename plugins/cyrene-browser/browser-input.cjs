"use strict";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withInputDebugger(contents, operation) {
  const client = contents?.debugger;
  if (!client || client.isAttached()) throw new Error("调试输入通道正被占用");
  let attached = false;
  try {
    client.attach("1.3");
    attached = true;
    await client.sendCommand("Page.bringToFront").catch(() => undefined);
    await client.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    return await operation(client);
  } finally {
    if (attached && client.isAttached()) {
      await client.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
      try { client.detach(); } catch { /* Cleanup must not replay a completed input. */ }
    }
  }
}

function fallbackClick(contents, point, clickCount) {
  contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount });
  contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount });
}

async function dispatchClick(contents, point, clickCount = 1) {
  let pressed = false;
  try {
    await withInputDebugger(contents, async (client) => {
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount,
      });
      pressed = true;
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount,
      });
    });
  } catch (error) {
    if (pressed) throw error;
    fallbackClick(contents, point, clickCount);
  }
}

async function dispatchHover(contents, point) {
  try {
    await withInputDebugger(contents, (client) => client.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    }));
  } catch {
    contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  }
}

async function dispatchDrag(contents, source, target) {
  let pressed = false;
  try {
    await withInputDebugger(contents, async (client) => {
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.x,
        y: source.y,
      });
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: source.x,
        y: source.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      pressed = true;
      for (let index = 1; index <= 10; index += 1) {
        const ratio = index / 10;
        await client.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(source.x + (target.x - source.x) * ratio),
          y: Math.round(source.y + (target.y - source.y) * ratio),
          button: "left",
          buttons: 1,
        });
        await delay(16);
      }
      await client.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: target.x,
        y: target.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    });
  } catch (error) {
    if (pressed) throw error;
    contents.sendInputEvent({ type: "mouseMove", x: source.x, y: source.y });
    contents.sendInputEvent({ type: "mouseDown", x: source.x, y: source.y, button: "left", clickCount: 1 });
    for (let index = 1; index <= 10; index += 1) {
      const ratio = index / 10;
      contents.sendInputEvent({
        type: "mouseMove",
        x: Math.round(source.x + (target.x - source.x) * ratio),
        y: Math.round(source.y + (target.y - source.y) * ratio),
        button: "left",
      });
      await delay(16);
    }
    contents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
  }
}

async function replaceText(contents, text, platform) {
  let mutationStarted = false;
  try {
    await withInputDebugger(contents, async (client) => {
      const modifier = platform === "darwin" ? 4 : 2;
      await client.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        modifiers: modifier,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await client.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: modifier,
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
      await client.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      mutationStarted = true;
      await client.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
      });
      if (text) await client.sendCommand("Input.insertText", { text });
    });
  } catch (error) {
    if (mutationStarted) throw error;
    const modifier = platform === "darwin" ? "meta" : "control";
    contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [modifier] });
    contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [modifier] });
    contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    if (text) contents.insertText(text);
  }
}

function keyDefinition(keyCode, modifiers) {
  const named = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
    Up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    Down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    Left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    Right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  };
  if (named[keyCode]) return { ...named[keyCode] };
  const functionKey = /^F([1-9]|1[0-2])$/.exec(keyCode);
  if (functionKey) {
    return { key: keyCode, code: keyCode, windowsVirtualKeyCode: 111 + Number(functionKey[1]) };
  }
  const character = String(keyCode || "").slice(0, 1);
  const upper = character.toUpperCase();
  const isLetter = /^[A-Z]$/.test(upper);
  const isDigit = /^\d$/.test(character);
  return {
    key: character,
    code: isLetter ? `Key${upper}` : (isDigit ? `Digit${character}` : ""),
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: modifiers.some((value) => ["alt", "control", "meta"].includes(value)) ? undefined : character,
  };
}

function cdpModifierMask(modifiers) {
  const bits = { alt: 1, control: 2, meta: 4, shift: 8 };
  return modifiers.reduce((mask, value) => mask | (bits[value] || 0), 0);
}

async function dispatchKey(contents, keyCode, modifiers = []) {
  let keyDownSent = false;
  try {
    await withInputDebugger(contents, async (client) => {
      const definition = keyDefinition(keyCode, modifiers);
      const modifierMask = cdpModifierMask(modifiers);
      const down = {
        type: "keyDown",
        modifiers: modifierMask,
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
        nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      };
      if (definition.text !== undefined) {
        down.text = definition.text;
        down.unmodifiedText = definition.text;
      }
      await client.sendCommand("Input.dispatchKeyEvent", down);
      keyDownSent = true;
      await client.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: modifierMask,
        key: definition.key,
        code: definition.code,
        windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
        nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      });
    });
  } catch (error) {
    if (keyDownSent) throw error;
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }
}

module.exports = Object.freeze({
  dispatchClick,
  dispatchHover,
  dispatchDrag,
  replaceText,
  dispatchKey,
});

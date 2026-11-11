import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { NES } from "jsnes";
import { installMmc1PrgCorrection } from "../src/mmc1-prg.js";
import { cartridge, serial, bankPair } from "./support/mmc1-rom.mjs";

// Exercise the real application handlers with deterministic DOM/network/audio
// boundaries. Diagnostic cartridges also exercise the real core and mapper.
const source = fs.readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "");
const manifest = [
  { id: "hangar", title: "Hangar", url: "/roms/hangar-ntsc-644d047c.nes" },
  { id: "melo-jellos-2", title: "Melo-Jellos 2", url: "/roms/melo-jellos-2.nes" },
];
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0)).buffer;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  listeners = new Map();
  children = [];
  dataset = {};
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  classList = { add() {}, remove() {} };
  attributes = {};
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  addEventListener(event, callback) { this.listeners.set(event, callback); }
  appendChild(child) { this.children.push(child); }
  dispatch(event) { this.listeners.get(event)?.({ preventDefault() {} }); }
}
function app(search = "", { delayedAudio = false, constructorError = false, realCore = false } = {}) {
  const ids = ["app", "nes-screen", "rom-file", "hosted-roms", "pause-button", "status", "dpad", "launch-game", "controls-button", "hangar-controls"];
  const elements = new Map(ids.map((id) => [id, new Element()]));
  elements.get("launch-game").hidden = true;
  elements.get("controls-button").hidden = true;
  elements.get("hangar-controls").hidden = true;
  elements.get("pause-button").disabled = true;
  const requests = [];
  const audio = deferred();
  if (!delayedAudio) audio.resolve();
  const instances = [];
  const audioStarts = [];
  let generatedFrames = 0;
  class Browser {
    constructor() {
      if (constructorError) throw new Error("AudioContext construction failed");
      instances.push(this);
      this.loads = [];
      this.buttonUps = [];
      this.audioStarts = 0;
      this.audioStops = 0;
      this._frameTimer = { onGenerateFrame() { generatedFrames++; } };
      this._speakers = {
        onBufferUnderrun: () => this._frameTimer.onGenerateFrame(),
        start: () => {
          this.audioStarts++;
          const pending = this.audioStarts === 1 ? audio : deferred();
          audioStarts.push(pending);
          this._speakers.audioCtx = {
            state: "suspended", sampleRate: 48000,
            resume() { this.state = "running"; return Promise.resolve(); },
          };
          const context = this._speakers.audioCtx;
          return pending.promise.then(() => {
            assert.equal(this._speakers.audioCtx, context, "audio context closed before worklet initialization completed");
          });
        },
        stop: () => { this.audioStops++; this._speakers.audioCtx = null; },
      };
      this.nes = {
        loadROM: (data) => {
          if (data === "BAD") throw new Error("Invalid NES cartridge");
          this.loads.push(data);
        },
        opts: {}, papu: { setPanning() {}, setFrameRate() {} },
        buttonDown() {}, buttonUp: (_player, button) => this.buttonUps.push(button),
      };
      if (realCore) this.nes = new NES({ emulateSound: false });
    }
    loadROM() { throw new Error("Browser.loadROM would discard the primed context"); }
    start() { this._speakers.start(); }
    stop() { this._speakers.stop(); }
    fitInParent() {}
  }
  const documentListeners = new Map();
  const document = {
    querySelector: (selector) => elements.get(selector.slice(1)),
    querySelectorAll: () => [],
    createElement: () => new Element(),
    addEventListener(type, callback, capture) {
      if (capture) documentListeners.set(type, callback);
    },
  };
  const context = vm.createContext({
    Browser, Controller: Object.fromEntries(["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT", "TURBO_A", "TURBO_B"].map((name, index) => ["BUTTON_" + name, index])), document,
    window: { location: { search }, addEventListener() {} },
    URLSearchParams, Uint8Array, AbortController, console, setTimeout,
    installMmc1PrgCorrection,
    requestAnimationFrame(callback) { callback(); },
    fetch(url, options) {
      const result = deferred();
      requests.push({ url, options, ...result });
      return result.promise;
    },
  });
  vm.runInContext(source, context);
  return {
    elements, requests, instances, audio, audioStarts, documentListeners,
    frames: () => generatedFrames,
    manifest(entries = manifest) { requests[0].resolve({ ok: true, json: async () => entries }); },
    rom(index, data) { requests[index].resolve({ ok: true, arrayBuffer: async () => bytes(data) }); },
    choose(id) { elements.get("hosted-roms").value = id; elements.get("hosted-roms").dispatch("change"); },
    play() { elements.get("launch-game").dispatch("click"); },
    file(promise, name = "local.nes") {
      elements.get("rom-file").files = [{ name, arrayBuffer: () => promise }];
      elements.get("rom-file").dispatch("change");
    },
  };
}

test("local and hosted application loads install MMC1 banking before playback", async () => {
  for (const local of [true, false]) {
    const page = app("", { realCore: true });
    page.manifest(); await tick();
    if (local) page.file(Promise.resolve(bytes(cartridge())));
    else { page.choose("melo-jellos-2"); page.rom(1, cartridge()); }
    await tick();
    const nes = page.instances[0].nes;
    serial(nes.mmap, 0x8000, 3);
    serial(nes.mmap, 0xe000, 4);
    assert.deepEqual(bankPair(nes), [4, 5]);
    serial(nes.mmap, 0x8000, 15);
    assert.deepEqual(bankPair(nes), [4, 7]);
  }
});

test("local and hosted 256 KiB MMC1 games run even when audio startup never settles", async () => {
  for (const local of [true, false]) {
    const page = app("", { realCore: true, delayedAudio: true });
    page.manifest(); await tick();
    const rom = cartridge({ banks: 16 });
    if (local) page.file(Promise.resolve(bytes(rom)));
    else { page.choose("melo-jellos-2"); page.rom(1, rom); }
    await tick();
    const instance = page.instances[0];
    assert.equal(instance.nes.rom.romCount, 16);
    serial(instance.nes.mmap, 0x8000, 3);
    serial(instance.nes.mmap, 0xe000, 12);
    assert.deepEqual(bankPair(instance.nes), [12, 13]);
    serial(instance.nes.mmap, 0x8000, 15);
    assert.deepEqual(bankPair(instance.nes), [12, 15]);
    let rendered = 0;
    instance.nes.ui.writeFrame = () => rendered++;
    instance.nes.frame(); instance.nes.frame();
    assert.equal(rendered, 2);
    assert.equal(instance.audioStarts, 1);
    assert.equal(page.elements.get("pause-button").disabled, false);
    assert.match(page.elements.get("status").textContent, /^Playing /);
  }
});

test("file, network and cartridge errors are reported while audio remains pending", async () => {
  for (const failure of ["file", "network", "cartridge"]) {
    const page = app("", { delayedAudio: true });
    page.manifest(); await tick();
    if (failure === "file") page.file(Promise.reject(new Error("File read failed")));
    else if (failure === "network") {
      page.choose("melo-jellos-2");
      page.requests[1].reject(new Error("Network failed"));
    } else page.file(Promise.resolve(bytes("BAD")));
    await tick();
    const instance = page.instances[0];
    assert.match(page.elements.get("status").textContent, /File read failed|Network failed|Invalid NES cartridge/);
    assert.equal(page.elements.get("status").dataset.tone, "error");
    assert.equal(page.elements.get("pause-button").disabled, true);
    assert.equal(instance.audioStops, 0, "pending worklet still owns its context");
    instance._speakers.onBufferUnderrun();
    instance._frameTimer.onGenerateFrame();
    assert.equal(page.frames(), 0);
    const status = page.elements.get("status").textContent;
    page.audio.resolve(); await tick();
    assert.equal(instance._speakers.audioCtx, null);
    assert.equal(page.elements.get("status").textContent, status);
  }
});

test("a new cartridge recovers immediately from an error while reusing pending audio", async () => {
  const page = app("", { delayedAudio: true });
  page.manifest(); await tick();
  page.file(Promise.resolve(bytes("BAD"))); await tick();
  assert.match(page.elements.get("status").textContent, /Invalid NES cartridge/);
  const instance = page.instances[0];
  const context = instance._speakers.audioCtx;
  page.file(Promise.resolve(bytes("RECOVERED")), "recovered.nes"); await tick();
  assert.deepEqual(instance.loads, ["RECOVERED"]);
  assert.equal(instance.audioStarts, 1);
  page.audio.resolve(); await tick();
  assert.equal(instance._speakers.audioCtx, context);
  assert.match(page.elements.get("status").textContent, /^Playing recovered.nes/);
});

test("late audio success or failure preserves the newest cartridge and frame state", async () => {
  for (const rejectAudio of [false, true]) {
    const page = app("", { delayedAudio: true });
    page.manifest(); await tick();
    page.file(Promise.resolve(bytes("FIRST")), "first.nes"); await tick();
    page.choose("melo-jellos-2"); page.rom(1, "SECOND"); await tick();
    const instance = page.instances[0];
    assert.deepEqual(instance.loads, ["FIRST", "SECOND"]);
    assert.equal(instance.audioStarts, 1);
    if (rejectAudio) page.audio.reject(new Error("AudioWorklet unavailable"));
    else page.audio.resolve();
    await tick();
    assert.match(page.elements.get("status").textContent, /^Playing Melo-Jellos 2/);
    if (rejectAudio) assert.match(page.elements.get("status").textContent, /audio unavailable/);
    instance._frameTimer.onGenerateFrame();
    assert.equal(page.frames(), 1);
    assert.deepEqual(instance.loads, ["FIRST", "SECOND"]);
  }
});

test("Pause before initial audio completes remains paused after late success or failure", async () => {
  for (const rejectAudio of [false, true]) {
    const page = app("", { delayedAudio: true });
    page.manifest(); await tick();
    page.file(Promise.resolve(bytes("LOCAL"))); await tick();
    const instance = page.instances[0];
    page.elements.get("pause-button").dispatch("click");
    assert.equal(instance.audioStops, 0);
    if (rejectAudio) page.audio.reject(new Error("AudioWorklet unavailable"));
    else page.audio.resolve();
    await tick();
    assert.equal(instance._speakers.audioCtx, null);
    assert.match(page.elements.get("status").textContent, /^Paused local.nes/);
    assert.equal(page.elements.get("pause-button").textContent, "Resume");
    instance._speakers.onBufferUnderrun();
    instance._frameTimer.onGenerateFrame();
    assert.equal(page.frames(), 0);
    page.elements.get("pause-button").dispatch("click");
    if (!rejectAudio) { page.audioStarts[1].resolve(); await tick(); }
    instance._frameTimer.onGenerateFrame();
    assert.equal(page.frames(), 1);
    assert.match(page.elements.get("status").textContent, /^Playing local.nes/);
  }
});

test("deep link waits for Play, unlocks audio before fetch, and ignores duplicate clicks", async () => {
  const page = app("?game=hangar", { delayedAudio: true });
  page.manifest(); await tick();
  assert.equal(page.elements.get("launch-game").textContent, "Play Hangar");
  assert.equal(page.elements.get("launch-game").hidden, false);
  assert.equal(page.requests.length, 1);
  assert.equal(page.instances.length, 0);
  page.elements.get("launch-game").dispatch("click");
  page.elements.get("launch-game").dispatch("click");
  assert.equal(page.requests.length, 2);
  assert.equal(page.instances[0].audioStarts, 1);
  assert.equal(page.instances[0]._speakers.audioCtx.state, "running");
  page.instances[0]._speakers.onBufferUnderrun();
  page.instances[0]._frameTimer.onGenerateFrame();
  assert.equal(page.frames(), 0);
  page.rom(1, "HANGAR"); await tick();
  assert.deepEqual(page.instances[0].loads, ["HANGAR"]);
  assert.equal(page.instances[0].audioStarts, 1);
  assert.match(page.elements.get("status").textContent, /^Playing Hangar/);
  page.audio.resolve(); await tick();
  assert.deepEqual(page.instances[0].loads, ["HANGAR"]);
  assert.equal(page.instances[0].audioStarts, 1);
  assert.equal(page.elements.get("pause-button").disabled, false);
  assert.match(page.elements.get("status").textContent, /^Playing Hangar/);
  page.instances[0]._speakers.onBufferUnderrun();
  assert.equal(page.frames(), 1);
});

test("unknown and arbitrary URL query values never become ROM URLs", async () => {
  for (const search of ["?game=missing", "?game=https%3A%2F%2Fexample.com%2Fgame.nes", "?game="]) {
    const page = app(search); page.manifest(); await tick();
    assert.equal(page.elements.get("launch-game").hidden, true);
    assert.equal(page.requests.length, 1);
    assert.match(page.elements.get("status").textContent, /Game not found/);
  }
});

test("no-query hosted selector still loads; malformed and duplicate rows are ignored", async () => {
  const page = app();
  page.manifest([null, {}, { id: "remote", title: "Remote", url: "https://example.com/a.nes" }, ...manifest, manifest[0]]);
  await tick();
  assert.equal(page.elements.get("launch-game").hidden, true);
  assert.equal(page.elements.get("hosted-roms").children.length, 2);
  page.choose("melo-jellos-2"); page.rom(1, "MELO"); await tick();
  assert.deepEqual(page.instances[0].loads, ["MELO"]);
});

test("a new local file wins over a delayed hosted load, including pending audio", async () => {
  const page = app("?game=hangar", { delayedAudio: true });
  page.manifest(); await tick(); page.elements.get("launch-game").dispatch("click");
  page.file(Promise.resolve(bytes("LOCAL")));
  assert.equal(page.requests[1].options.signal.aborted, true);
  assert.equal(page.instances[0].audioStarts, 1);
  assert.equal(page.instances[0].audioStops, 0);
  page.rom(1, "STALE"); page.audio.resolve(); await tick();
  assert.deepEqual(page.instances[0].loads, ["LOCAL"]);
  assert.match(page.elements.get("status").textContent, /^Playing local.nes/);
  assert.equal(page.elements.get("launch-game").hidden, true);
});

test("a newer hosted selection wins over delayed file and hosted responses", async () => {
  const page = app("?game=hangar"); page.manifest(); await tick();
  const file = deferred(); page.file(file.promise);
  page.choose("hangar"); page.play(); page.choose("melo-jellos-2");
  assert.equal(page.requests[1].options.signal.aborted, true);
  page.rom(2, "WINNER"); await tick();
  page.rom(1, "OLD_HOSTED"); file.resolve(bytes("OLD_FILE")); await tick();
  assert.deepEqual(page.instances[0].loads, ["WINNER"]);
});

test("late manifest success or failure cannot overwrite a local game", async () => {
  for (const failure of [false, true]) {
    const page = app("?game=hangar");
    page.file(Promise.resolve(bytes("LOCAL"))); await tick();
    if (failure) page.requests[0].reject(new Error("offline")); else page.manifest();
    await tick();
    assert.equal(page.elements.get("launch-game").hidden, true);
    assert.match(page.elements.get("status").textContent, /^Playing local.nes/);
  }
});

test("manifest failures and malformed roots leave local uploads available", async () => {
  for (const invalid of [null, {}, []]) {
    const page = app("?game=hangar"); page.manifest(invalid); await tick();
    assert.equal(page.elements.get("hosted-roms").disabled, true);
    assert.match(page.elements.get("status").textContent, /still open a .nes file/);
    page.file(Promise.resolve(bytes("LOCAL"))); await tick();
    assert.deepEqual(page.instances[0].loads, ["LOCAL"]);
  }
});

test("fetch and cartridge errors recover through a later hosted selection", async () => {
  const page = app("?game=hangar"); page.manifest(); await tick();
  page.elements.get("launch-game").dispatch("click");
  page.requests[1].resolve({ ok: false, status: 404 }); await tick();
  assert.match(page.elements.get("status").textContent, /404/);
  assert.equal(page.elements.get("pause-button").disabled, true);
  page.choose("hangar"); page.play(); page.rom(2, "BAD"); await tick();
  page.audioStarts[1].resolve(); await tick();
  assert.match(page.elements.get("status").textContent, /Invalid NES cartridge/);
  page.choose("hangar"); page.play(); page.rom(3, "OK"); await tick();
  page.audioStarts[2].resolve(); await tick();
  assert.deepEqual(page.instances[0].loads, ["OK"]);
});

test("Resume followed by immediate Pause defers audio disposal without disabling it", async () => {
  const page = app(); page.manifest(); await tick();
  page.choose("hangar"); page.play(); page.rom(1, "HANGAR"); await tick();
  const instance = page.instances[0];
  const pause = page.elements.get("pause-button");
  pause.dispatch("click"); // stop initialized audio
  page.elements.get("nes-screen").focused = false;
  pause.dispatch("click"); // resume with a pending worklet
  assert.equal(page.elements.get("nes-screen").focused, true);
  const pendingContext = instance._speakers.audioCtx;
  pause.dispatch("click");
  assert.equal(instance._speakers.audioCtx, pendingContext);
  page.audioStarts[1].resolve(); await tick();
  assert.equal(instance._speakers.audioCtx, null);
  pause.dispatch("click");
  assert.equal(instance.audioStarts, 3);
  page.audioStarts[2].resolve(); await tick();
  assert.ok(instance._speakers.audioCtx);
  assert.match(page.elements.get("status").textContent, /^Playing Hangar/);
});

test("Resume followed by a new ROM reuses its pending worklet safely", async () => {
  const page = app(); page.manifest(); await tick();
  page.choose("hangar"); page.play(); page.rom(1, "HANGAR"); await tick();
  const pause = page.elements.get("pause-button");
  pause.dispatch("click"); pause.dispatch("click");
  page.choose("melo-jellos-2"); page.rom(2, "MELO"); await tick();
  assert.equal(page.instances[0].audioStarts, 2);
  page.audioStarts[1].resolve(); await tick();
  assert.deepEqual(page.instances[0].loads, ["HANGAR", "MELO"]);
  assert.match(page.elements.get("status").textContent, /^Playing Melo-Jellos 2/);
});

test("synchronous emulator initialization failures use the accessible error status", async () => {
  const page = app("?game=hangar", { constructorError: true });
  page.manifest(); await tick(); page.elements.get("launch-game").dispatch("click");
  await tick();
  assert.match(page.elements.get("status").textContent, /AudioContext construction failed/);
  assert.equal(page.elements.get("pause-button").disabled, true);
  assert.equal(page.requests.length, 1);
});

test("Hangar deep link and picker both show the guide before fetching a cartridge", async () => {
  for (const search of ["", "?game=hangar"]) {
    const page = app(search); page.manifest(); await tick();
    if (!search) page.choose("hangar");
    assert.equal(page.requests.length, 1);
    assert.equal(page.instances.length, 0);
    assert.equal(page.elements.get("hangar-controls").hidden, false);
    assert.equal(page.elements.get("controls-button").hidden, false);
    assert.equal(page.elements.get("controls-button").attributes["aria-expanded"], "true");
    page.play();
    assert.equal(page.elements.get("hangar-controls").hidden, true);
    assert.equal(page.elements.get("controls-button").hidden, false);
    assert.equal(page.requests.length, 2);
    page.rom(1, "HANGAR"); await tick();
    assert.equal(page.elements.get("nes-screen").focused, true);
  }
});

test("reopened Controls pauses the game and closing it resumes a previously running game", async () => {
  const page = app("?game=hangar"); page.manifest(); await tick();
  page.play(); page.rom(1, "HANGAR"); await tick();
  const instance = page.instances[0];
  const controls = page.elements.get("controls-button");
  instance._frameTimer.onGenerateFrame();
  controls.dispatch("click");
  assert.equal(page.elements.get("hangar-controls").hidden, false);
  assert.equal(page.elements.get("pause-button").disabled, true);
  assert.match(page.elements.get("status").textContent, /Hangar is paused/);
  instance._frameTimer.onGenerateFrame();
  assert.equal(page.frames(), 1);
  assert.equal(new Set(instance.buttonUps).size, 10);
  page.elements.get("nes-screen").focused = false;
  controls.dispatch("click");
  assert.equal(page.elements.get("nes-screen").focused, true);
  page.audioStarts[1].resolve(); await tick();
  assert.equal(page.elements.get("hangar-controls").hidden, true);
  assert.equal(page.elements.get("pause-button").disabled, false);
  assert.match(page.elements.get("status").textContent, /^Playing Hangar/);
  instance._frameTimer.onGenerateFrame();
  assert.equal(page.frames(), 2);
});

test("opening and closing Controls preserves an already paused game", async () => {
  const page = app("?game=hangar"); page.manifest(); await tick();
  page.play(); page.rom(1, "HANGAR"); await tick();
  page.elements.get("pause-button").dispatch("click");
  page.elements.get("controls-button").dispatch("click");
  page.elements.get("controls-button").dispatch("click");
  assert.equal(page.instances[0].audioStarts, 1);
  assert.equal(page.elements.get("pause-button").textContent, "Resume");
  assert.match(page.elements.get("status").textContent, /^Paused Hangar/);
  page.instances[0]._frameTimer.onGenerateFrame();
  assert.equal(page.frames(), 0);
});

test("switching to Melo-Jellos or a local file clears the Hangar guide", async () => {
  for (const local of [false, true]) {
    const page = app("?game=hangar"); page.manifest(); await tick();
    if (local) page.file(Promise.resolve(bytes("LOCAL")));
    else { page.choose("melo-jellos-2"); page.rom(1, "MELO"); }
    await tick();
    assert.equal(page.elements.get("hangar-controls").hidden, true);
    assert.equal(page.elements.get("controls-button").hidden, true);
    assert.equal(page.elements.get("launch-game").hidden, true);
    assert.deepEqual(page.instances[0].loads, [local ? "LOCAL" : "MELO"]);
  }
});

test("choosing the Hangar guide cancels an older pending game without starting Hangar", async () => {
  const page = app("", { delayedAudio: true }); page.manifest(); await tick();
  page.choose("melo-jellos-2"); page.choose("hangar");
  assert.equal(page.requests[1].options.signal.aborted, true);
  page.rom(1, "STALE"); page.audio.resolve(); await tick();
  assert.equal(page.requests.length, 2);
  assert.deepEqual(page.instances[0].loads, []);
  assert.equal(page.elements.get("hangar-controls").hidden, false);
  assert.match(page.elements.get("status").textContent, /Hangar is ready/);
});

test("UI and guide keys keep native defaults; game-area keys can reach JSNES", async () => {
  const page = app("?game=hangar"); page.manifest(); await tick();
  page.play(); page.rom(1, "HANGAR"); await tick();
  let stopped = 0, prevented = 0;
  const event = (ui) => ({
    target: { closest: () => ui },
    stopPropagation() { stopped++; }, preventDefault() { prevented++; },
  });
  page.documentListeners.get("keydown")(event(true));
  assert.equal(stopped, 1);
  assert.equal(prevented, 0);
  page.documentListeners.get("keydown")(event(false));
  assert.equal(stopped, 1);
  page.instances[0].buttonUps = [];
  page.documentListeners.get("keyup")(event(true));
  assert.equal(new Set(page.instances[0].buttonUps).size, 10);
  page.elements.get("controls-button").dispatch("click");
  page.documentListeners.get("keydown")(event(false));
  assert.equal(stopped, 3);
});

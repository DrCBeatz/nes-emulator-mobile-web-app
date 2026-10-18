import { Browser, Controller } from "jsnes";
import "./styles.css";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <section class="topbar" aria-label="ROM controls">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>8-Bit Pocket</span>
      </div>
      <div class="rom-actions">
        <label class="file-button">
          Open ROM
          <input id="rom-file" type="file" accept=".nes,application/octet-stream" />
        </label>
        <select id="hosted-roms" aria-label="Hosted ROMs">
          <option value="">Hosted ROMs</option>
        </select>
        <button id="pause-button" type="button" disabled>Pause</button>
      </div>
    </section>

    <section class="stage" aria-label="NES emulator">
      <div id="nes-screen" class="screen" aria-label="Game screen"></div>
      <div class="stage-actions">
        <button id="launch-game" class="launch-game" type="button" hidden>Play Hangar</button>
        <p id="status" class="status" role="status" aria-live="polite" aria-atomic="true">Open a .nes file to start.</p>
      </div>
    </section>

    <section class="controller" aria-label="NES controller">
      <div id="dpad" class="dpad" aria-label="Directional pad">
        <span class="dpad-cross" aria-hidden="true"></span>
      </div>

      <div class="menu-buttons">
        <button class="small-control" data-button="select" type="button">Select</button>
        <button class="small-control" data-button="start" type="button">Start</button>
      </div>

      <div class="face-buttons" aria-label="Action buttons">
        <button class="turbo-control" data-button="turbo-b" type="button">Turbo B</button>
        <button class="turbo-control" data-button="turbo-a" type="button">Turbo A</button>
        <button class="round-control b-button" data-button="b" type="button">B</button>
        <button class="round-control a-button" data-button="a" type="button">A</button>
      </div>
    </section>
  </main>
`;

const screenEl = document.querySelector("#nes-screen");
const fileInput = document.querySelector("#rom-file");
const hostedSelect = document.querySelector("#hosted-roms");
const pauseButton = document.querySelector("#pause-button");
const statusEl = document.querySelector("#status");
const dpadEl = document.querySelector("#dpad");
const launchButton = document.querySelector("#launch-game");

const buttonMap = {
  a: Controller.BUTTON_A,
  b: Controller.BUTTON_B,
  "turbo-a": Controller.BUTTON_TURBO_A,
  "turbo-b": Controller.BUTTON_TURBO_B,
  select: Controller.BUTTON_SELECT,
  start: Controller.BUTTON_START,
};

let emulator = null;
let running = false;
let loadedRomName = "";
let audioSampleRate = null;
let loading = false;
let loadSequence = 0;
let pendingFetch = null;
let linkedGame = null;
const hostedRoms = new Map();
const requestedGame = new URLSearchParams(window.location.search).get("game");
const heldButtons = new Map();
const dpadStateByPointer = new Map();

function setStatus(message, tone = "normal") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function installAudioContextFallback() {
  if (!window.AudioContext && window.webkitAudioContext) {
    window.AudioContext = window.webkitAudioContext;
  }
}

function guardSpeakerStartup(speakers) {
  if (!speakers || speakers.eightBitPocketGuarded) return;

  const startSpeakers = speakers.start.bind(speakers);
  const stopSpeakers = speakers.stop.bind(speakers);
  const onBufferUnderrun = speakers.onBufferUnderrun;
  let starting = null;
  let stopRequested = false;

  // Priming audio must not execute NES frames before a ROM has loaded.
  speakers.onBufferUnderrun = () => {
    if (running && !loading) onBufferUnderrun?.();
  };

  speakers.start = () => {
    stopRequested = false;
    if (starting) return starting;
    if (speakers.audioCtx) {
      resumeAudioContext();
      return Promise.resolve();
    }

    // startSpeakers creates its AudioContext synchronously, while the click
    // gesture is active. Reuse that context when the fetched ROM starts.
    starting = startSpeakers().catch((error) => {
      console.warn("JSNES audio output is unavailable in this browser.", error);
      stopSpeakers();
      speakers.start = () => Promise.resolve();
      speakers.writeSample = () => {};
      speakers.flush = () => {};
      audioSampleRate = null;

      if (running && loadedRomName) {
        setStatus(`Playing ${loadedRomName} - audio unavailable`);
      }
    }).finally(() => {
      starting = null;
      if (stopRequested) stopSpeakers();
    });
    resumeAudioContext();
    return starting;
  };

  speakers.stop = () => {
    stopRequested = true;
    // A quick Pause or another ROM selection can arrive during Resume's
    // worklet initialization too. Its context must remain valid until done.
    if (!starting) stopSpeakers();
  };

  speakers.eightBitPocketGuarded = true;
}

function ensureEmulator() {
  if (emulator) return emulator;

  installAudioContextFallback();

  emulator = new Browser({
    container: screenEl,
    onError(error) {
      running = false;
      pauseButton.textContent = "Resume";
      setStatus(error.message || "The emulator stopped unexpectedly.", "error");
    },
  });
  guardSpeakerStartup(emulator._speakers);
  const generateFrame = emulator._frameTimer.onGenerateFrame;
  emulator._frameTimer.onGenerateFrame = () => {
    // The upstream timer may still have setTimeout catch-up frames queued
    // after stop(); they must not run an old or partially loaded cartridge.
    if (running && !loading) generateFrame();
  };

  window.addEventListener("resize", () => emulator?.fitInParent());
  return emulator;
}

function resumeAudioContext() {
  const audioContext = emulator?._speakers?.audioCtx;
  if (audioContext?.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
}

function bytesToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let result = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return result;
}

async function loadRomFromFile(file) {
  if (!file) return;
  let request;

  try {
    request = beginRomLoad(file.name);
    const [buffer] = await Promise.all([file.arrayBuffer(), request.audioReady]);
    if (request.sequence !== loadSequence) return;
    loadRomData(bytesToBinaryString(buffer), file.name, request.sequence);
  } catch (error) {
    await failRomLoad(request, error);
  }
}

function dismissLinkedGame() {
  launchButton.hidden = true;
  linkedGame = null;
}

function beginRomLoad(name) {
  const sequence = ++loadSequence;
  pendingFetch?.abort();
  pendingFetch = null;
  dismissLinkedGame();
  releaseAllButtons();
  // A previous in-progress request shares the primed audio startup. Do not
  // close that context while its AudioWorklet is still initializing.
  if (!loading) emulator?.stop();
  running = false;
  loading = true;
  loadedRomName = "";
  audioSampleRate = null;
  pauseButton.disabled = true;
  setStatus(`Loading ${name}...`);
  const audioReady = ensureEmulator()._speakers.start();
  return { sequence, audioReady };
}

async function loadHostedRom(rom) {
  if (!rom) return;
  let request;
  try {
    request = beginRomLoad(rom.title);
    const controller = new AbortController();
    pendingFetch = controller;
    const response = await fetch(rom.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load ${rom.title} (${response.status}).`);
    const [buffer] = await Promise.all([response.arrayBuffer(), request.audioReady]);
    if (request.sequence !== loadSequence) return;
    pendingFetch = null;
    loadRomData(bytesToBinaryString(buffer), rom.title, request.sequence);
  } catch (error) {
    await failRomLoad(request, error);
  }
}

async function failRomLoad(request, error) {
  // Wait before stopping speakers: the upstream worklet setup still uses
  // its context after its asynchronous addModule call.
  const sequence = request?.sequence ?? loadSequence;
  await request?.audioReady;
  if (sequence !== loadSequence) return;
  pendingFetch = null;
  loading = false;
  running = false;
  emulator?.stop();
  pauseButton.disabled = true;
  setStatus(error.message || "Could not load that ROM. Try selecting it again.", "error");
}

function loadRomData(data, name, sequence) {
  releaseAllButtons();
  // Browser.loadROM would close the AudioContext unlocked by the gesture.
  // Its frame timer is already stopped; load the core, then reuse the audio.
  emulator.nes.loadROM(data);
  // Original NES audio is mono; JSNES defaults to decorative stereo panning.
  emulator.nes.papu.setPanning([128, 128, 128, 128, 128]);
  running = true;
  loading = false;
  loadedRomName = name;
  emulator.start();
  pauseButton.disabled = false;
  pauseButton.textContent = "Pause";
  setStatus(`Playing ${name}`);
  requestAnimationFrame(() => emulator?.fitInParent());
  syncAudioSampleRate(sequence);
}

async function syncAudioSampleRate(sequence) {
  const activeEmulator = emulator;
  if (!activeEmulator?._speakers || !activeEmulator?.nes?.papu) return;

  for (let attempt = 0; attempt < 20; attempt++) {
    if (sequence !== loadSequence || !running || loading) return;
    const sampleRate = activeEmulator._speakers.audioCtx?.sampleRate;

    if (sampleRate) {
      activeEmulator.nes.opts.sampleRate = sampleRate;
      activeEmulator.nes.papu.sampleRate = sampleRate;
      activeEmulator.nes.papu.setFrameRate(60);
      audioSampleRate = sampleRate;

      if (loadedRomName) {
        setStatus(`Playing ${loadedRomName} - audio ${sampleRate} Hz`);
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function loadHostedRomManifest() {
  try {
    const response = await fetch("/roms/manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error("No hosted ROM manifest found.");

    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid hosted ROM manifest.");
    for (const rom of entries) {
      if (!rom || typeof rom.id !== "string" || !/^[a-z0-9-]+$/.test(rom.id) ||
          typeof rom.title !== "string" || !rom.title.trim() ||
          typeof rom.url !== "string" || !/^\/roms\/[a-zA-Z0-9._-]+\.nes$/.test(rom.url) ||
          hostedRoms.has(rom.id)) continue;
      hostedRoms.set(rom.id, rom);
    }
    if (!hostedRoms.size) throw new Error("No hosted ROMs available.");

    hostedSelect.innerHTML = `<option value="">Hosted ROMs</option>`;
    for (const rom of hostedRoms.values()) {
      const option = document.createElement("option");
      option.value = rom.id;
      option.textContent = rom.title;
      hostedSelect.appendChild(option);
    }
    // A slow manifest must not replace a local file the player chose first.
    if (requestedGame !== null && loadSequence === 0) {
      linkedGame = hostedRoms.get(requestedGame) || null;
      if (linkedGame) {
        launchButton.textContent = `Play ${linkedGame.title}`;
        launchButton.hidden = false;
        setStatus(`${linkedGame.title} is ready. Press Play to start with sound.`);
      } else {
        setStatus("Game not found. Choose a hosted ROM or open a .nes file.", "error");
      }
    }
  } catch {
    hostedSelect.disabled = true;
    if (loadSequence === 0) {
      dismissLinkedGame();
      setStatus("Hosted ROMs are unavailable. You can still open a .nes file.", "error");
    }
  }
}

function pressButton(button) {
  if (!emulator || heldButtons.has(button)) return;
  heldButtons.set(button, true);
  emulator.nes.buttonDown(1, button);
}

function releaseButton(button) {
  if (!emulator || !heldButtons.has(button)) return;
  heldButtons.delete(button);
  emulator.nes.buttonUp(1, button);
}

function releaseAllButtons() {
  for (const button of heldButtons.keys()) {
    emulator?.nes.buttonUp(1, button);
  }
  heldButtons.clear();
  dpadStateByPointer.clear();
}

function setDpadButtons(pointerId, nextButtons) {
  const previousButtons = dpadStateByPointer.get(pointerId) || new Set();

  for (const button of previousButtons) {
    if (!nextButtons.has(button)) releaseButton(button);
  }

  for (const button of nextButtons) {
    pressButton(button);
  }

  dpadStateByPointer.set(pointerId, nextButtons);
  updateDpadVisualState();
}

function buttonsFromDpadPointer(event) {
  const rect = dpadEl.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const dx = event.clientX - centerX;
  const dy = event.clientY - centerY;
  const threshold = rect.width * 0.16;
  const buttons = new Set();

  if (dy < -threshold) buttons.add(Controller.BUTTON_UP);
  if (dy > threshold) buttons.add(Controller.BUTTON_DOWN);
  if (dx < -threshold) buttons.add(Controller.BUTTON_LEFT);
  if (dx > threshold) buttons.add(Controller.BUTTON_RIGHT);

  return buttons;
}

function releaseDpadPointer(pointerId) {
  setDpadButtons(pointerId, new Set());
  dpadStateByPointer.delete(pointerId);
  updateDpadVisualState();
}

function updateDpadVisualState() {
  const active = new Set();
  for (const buttons of dpadStateByPointer.values()) {
    for (const button of buttons) active.add(button);
  }

  dpadEl.dataset.up = active.has(Controller.BUTTON_UP);
  dpadEl.dataset.down = active.has(Controller.BUTTON_DOWN);
  dpadEl.dataset.left = active.has(Controller.BUTTON_LEFT);
  dpadEl.dataset.right = active.has(Controller.BUTTON_RIGHT);
}

function bindMomentaryButton(buttonEl, button) {
  buttonEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resumeAudioContext();
    buttonEl.setPointerCapture(event.pointerId);
    pressButton(button);
    buttonEl.classList.add("is-pressed");
  });

  const release = (event) => {
    event.preventDefault();
    releaseButton(button);
    buttonEl.classList.remove("is-pressed");
  };

  buttonEl.addEventListener("pointerup", release);
  buttonEl.addEventListener("pointercancel", release);
  buttonEl.addEventListener("lostpointercapture", () => {
    releaseButton(button);
    buttonEl.classList.remove("is-pressed");
  });
}

dpadEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  resumeAudioContext();
  dpadEl.setPointerCapture(event.pointerId);
  setDpadButtons(event.pointerId, buttonsFromDpadPointer(event));
});

dpadEl.addEventListener("pointermove", (event) => {
  if (!dpadStateByPointer.has(event.pointerId)) return;
  event.preventDefault();
  setDpadButtons(event.pointerId, buttonsFromDpadPointer(event));
});

dpadEl.addEventListener("pointerup", (event) => {
  event.preventDefault();
  releaseDpadPointer(event.pointerId);
});

dpadEl.addEventListener("pointercancel", (event) => {
  event.preventDefault();
  releaseDpadPointer(event.pointerId);
});

for (const buttonEl of document.querySelectorAll("[data-button]")) {
  bindMomentaryButton(buttonEl, buttonMap[buttonEl.dataset.button]);
}

fileInput.addEventListener("change", () => {
  loadRomFromFile(fileInput.files?.[0]);
  fileInput.value = "";
});

hostedSelect.addEventListener("change", () => {
  loadHostedRom(hostedRoms.get(hostedSelect.value));
  hostedSelect.value = "";
});

launchButton.addEventListener("click", () => {
  // beginRomLoad clears linkedGame synchronously, so repeated clicks cannot
  // issue a duplicate load, even before the first network request completes.
  if (linkedGame) loadHostedRom(linkedGame);
});

pauseButton.addEventListener("click", () => {
  if (!emulator || loading || !loadedRomName) return;

  if (running) {
    emulator.stop();
    releaseAllButtons();
    running = false;
    pauseButton.textContent = "Resume";
    setStatus(loadedRomName ? `Paused ${loadedRomName}` : "Paused");
    return;
  }

  emulator.start();
  running = true;
  pauseButton.textContent = "Pause";
  setStatus(loadedRomName ? `Playing ${loadedRomName}` : "Running");
  if (audioSampleRate && loadedRomName) {
    setStatus(`Playing ${loadedRomName} - audio ${audioSampleRate} Hz`);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllButtons();
});

document.addEventListener("selectstart", (event) => event.preventDefault());
document.addEventListener("dblclick", (event) => event.preventDefault(), {
  passive: false,
});

let lastTouchEndAt = 0;
document.addEventListener(
  "touchend",
  (event) => {
    if (event.target.closest(".controller, button, select, .file-button")) {
      return;
    }

    const now = Date.now();
    if (now - lastTouchEndAt < 350) {
      event.preventDefault();
    }
    lastTouchEndAt = now;
  },
  { passive: false },
);

loadHostedRomManifest();

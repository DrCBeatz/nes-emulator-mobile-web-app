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
      <p id="status" class="status">Open a .nes file to start.</p>
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

  window.addEventListener("resize", () => emulator?.fitInParent());
  pauseButton.disabled = false;
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
  setStatus(`Loading ${file.name}...`);

  try {
    const data = bytesToBinaryString(await file.arrayBuffer());
    loadRomData(data, file.name);
  } catch (error) {
    setStatus(error.message || "Could not load that ROM.", "error");
  }
}

function loadRomFromUrl(url, title) {
  if (!url) return;
  setStatus(`Loading ${title}...`);

  Browser.loadROMFromURL(url, (error, data) => {
    if (error || !data) {
      setStatus(error?.message || "Could not load that hosted ROM.", "error");
      return;
    }

    loadRomData(data, title);
  });
}

function loadRomData(data, name) {
  releaseAllButtons();
  ensureEmulator().loadROM(data);
  // Original NES audio is mono; JSNES defaults to decorative stereo panning.
  emulator.nes.papu.setPanning([128, 128, 128, 128, 128]);
  running = true;
  loadedRomName = name;
  pauseButton.textContent = "Pause";
  setStatus(`Playing ${name}`);
  requestAnimationFrame(() => emulator?.fitInParent());
  syncAudioSampleRate();
}

async function syncAudioSampleRate() {
  const activeEmulator = emulator;
  if (!activeEmulator?._speakers || !activeEmulator?.nes?.papu) return;

  for (let attempt = 0; attempt < 20; attempt++) {
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

    const roms = (await response.json()).filter((rom) => rom.title && rom.url);
    if (roms.length === 0) return;

    hostedSelect.innerHTML = `<option value="">Hosted ROMs</option>`;
    for (const rom of roms) {
      const option = document.createElement("option");
      option.value = rom.url;
      option.textContent = rom.title;
      hostedSelect.appendChild(option);
    }
  } catch {
    hostedSelect.disabled = true;
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
  const option = hostedSelect.selectedOptions[0];
  loadRomFromUrl(hostedSelect.value, option?.textContent || "Hosted ROM");
  hostedSelect.value = "";
});

pauseButton.addEventListener("click", () => {
  if (!emulator) return;

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

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { NES, Controller } from "jsnes";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseSha256 =
  "e7bc3df411d5f2d45aa325329ead3db7c75ebb8a51a0607df15777ce8456a8a9";
const coreCommit = "5b27c4243f1cb2528c54941e13c29c4ced7d5a45";

// Read-only symbols from this exact Hangar release's linker output. The ROM
// checksum is checked before using them; a different release needs a reviewed
// symbol update. No game RAM, CPU state, save state or PPU state is injected.
const address = {
  title: 1959, publication: 40, clockFrames: 1947, clockSeconds: 1948,
  clockMinutes: 1949, paused: 1953, cueTimer: 1957, angle: 0,
  x: 16, xHigh: 31821, z: 18, zHigh: 31822,
  visibleAngle: 25, visibleX: 26, visibleXHigh: 31825,
  visibleZ: 28, visibleZHigh: 31826, uploadBusy: 49,
  health: 1984, ammo: 1985, shots: 1990, mode: 2,
  enemyHp: 2017, hits: 2019, kills: 2020, enemyX: 240,
  enemyXHigh: 32480, enemyZ: 242, enemyZHigh: 32481,
  enemyEpoch: 244, visibleEnemyEpoch: 36, enemyTarget: 2022,
  corpse: 28344, simulation: 205, enemyAttack: 251, enemyTimer: 252,
  fireTimer: 1987, cooldown: 1986, activeEncounter: 2032,
  pickups: 58, door: 1883, visibleDoor: 1889, results: 1952,
  resultKills: 1950, resultItems: 1951, exitFlags: 1,
};
const button = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// This deliberately tests the emulation core separately from the browser UI.
// It does not certify canvas sizing, touch controls, audible browser output,
// network races, mobile performance or pixel-perfect Mesen equivalence.
test("hosted Hangar boots and plays in the pinned JSNES core", { timeout: 120_000 }, (t) => {
  const manifest = JSON.parse(readFileSync(resolve(root, "public/roms/manifest.json")));
  const game = manifest.find((entry) => entry.id === "hangar");
  assert.ok(game, "Hosted manifest must contain a stable Hangar ID");
  assert.ok(game.url.startsWith("/roms/"), "Use the same-origin hosted ROM");
  const publicRoot = resolve(root, "public");
  const romPath = resolve(publicRoot, game.url.slice(1));
  assert.ok(romPath.startsWith(publicRoot + sep));
  const rom = readFileSync(romPath);
  assert.equal(sha256(rom), releaseSha256, "ROM and read-only symbol map must match");
  if (game.sha256) assert.equal(game.sha256, releaseSha256);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json")));
  assert.equal(pkg.dependencies.jsnes, `github:taiyuuki/jsnes#${coreCommit}`);

  let frame = 0;
  let generatedPictures = 0;
  let audioSamples = 0;
  let nonzeroAudioSamples = 0;
  let picture = new Uint32Array(256 * 240);
  const nes = new NES({
    onFrame(pixels) {
      assert.equal(pixels.length, 256 * 240);
      picture = Uint32Array.from(pixels);
      generatedPictures++;
    },
    onAudioSample(left, right) {
      assert.ok(Number.isFinite(left) && Number.isFinite(right));
      audioSamples++;
      if (left !== 0 || right !== 0) nonzeroAudioSamples++;
    },
  });
  nes.loadROM(rom.toString("latin1"));
  assert.equal(nes.rom.mapperType, 1, "MMC1");
  assert.equal(nes.rom.romCount, 4, "64 KiB PRG ROM");
  assert.equal(nes.rom.vromCount, 0, "CHR RAM rather than CHR ROM");

  const byte = (name) => nes.cpu.mem[address[name]];
  const word = (name) => byte(name) + 256 * nes.cpu.mem[address[name] + 1];
  const coordinate = (name) => word(name) + 65536 * byte(name + "High");
  const clock = () => byte("clockMinutes") * 3600 + byte("clockSeconds") * 60 + byte("clockFrames");
  const state = () => ({
    x: coordinate("x"), z: coordinate("z"), angle: byte("angle"),
    health: byte("health"), ammo: byte("ammo"), shots: word("shots"),
    enemyX: coordinate("enemyX"), enemyZ: coordinate("enemyZ"),
    enemyHp: byte("enemyHp"), hits: byte("hits"), kills: byte("kills"),
    simulation: byte("simulation"), enemyAttack: byte("enemyAttack"),
    enemyTimer: byte("enemyTimer"), clock: clock(), mode: byte("mode"),
    publication: byte("publication"), uploadBusy: byte("uploadBusy"),
    fireTimer: byte("fireTimer"), cooldown: byte("cooldown"),
    activeEncounter: byte("activeEncounter"), pickups: byte("pickups"),
    door: byte("door"), results: byte("results"),
  });
  const setButtons = (names = []) => {
    const active = new Set(names);
    for (const [name, code] of Object.entries(button)) {
      nes[active.has(name) ? "buttonDown" : "buttonUp"](1, code);
    }
  };
  const step = (names = []) => {
    setButtons(names);
    nes.frame(); // The core's ordinary NTSC CPU/PPU/APU frame; no overclock.
    frame++;
    assert.equal(nes.crashed, false);
  };
  const run = (count, names = []) => {
    for (let i = 0; i < count; i++) step(names);
  };
  const until = (description, predicate, inputs, limit = 1200) => {
    for (let i = 0; i < limit; i++) {
      if (predicate()) return;
      step(typeof inputs === "function" ? inputs() : inputs);
    }
    assert.fail(`${description} timed out at frame ${frame}: ${JSON.stringify(state())}`);
  };
  const pictureHash = () => sha256(new Uint8Array(picture.buffer));
  const snapshots = {};

  run(120, ["start"]);
  assert.equal(byte("title"), 1, "Start already held at power-on cannot dismiss the title");
  assert.equal(clock(), 0);
  assert.ok(new Set(picture).size >= 3, "Title has rendered visible text/colors");
  const titlePicture = pictureHash();
  run(30, ["a", "b", "up", "right", "select"]);
  assert.equal(byte("title"), 1);
  assert.equal(clock(), 0);
  assert.equal(pictureHash(), titlePicture, "Other title inputs leave its image unchanged");
  run(2);
  const launchFrame = frame;
  until("first playable picture", () => byte("title") === 0 && byte("publication") === 1,
    ["start", "up", "right", "b", "select"], 300);
  const firstPictureFrame = frame;
  assert.equal(clock(), 0, "Title and first-picture preparation do not count as play time");
  assert.equal(coordinate("x"), 52 * 256);
  assert.equal(coordinate("z"), 172 * 256);
  assert.equal(byte("angle"), 0);
  assert.equal(byte("health"), 100);
  assert.equal(byte("ammo"), 6);
  assert.equal(word("shots"), 0);
  assert.equal(byte("mode"), 0, "Loading discards Select as well as movement/fire");
  run(60, ["start"]);
  assert.equal(byte("paused"), 0);
  assert.equal(clock(), 60);
  assert.notEqual(pictureHash(), titlePicture, "World picture replaces the title");
  snapshots.start = state();
  run(2);

  run(12, ["up"]);
  until("active upload", () => byte("uploadBusy") === 1, ["up"], 600);
  step(["start", "up"]);
  assert.equal(byte("paused"), 1);
  const frozen = state();
  run(90, ["start", "a", "b", "up", "down", "left", "right", "select"]);
  assert.deepEqual(state(), frozen, "Pause freezes world, clock, uploads and combat");
  assert.equal(byte("cueTimer"), 0, "The finite pause cue has stopped");
  run(2);
  step(["start"]);
  assert.equal(byte("paused"), 0);
  assert.deepEqual(state(), frozen, "Resume preserves the game on its transition frame");
  run(8, ["start"]);
  assert.equal(byte("paused"), 0);
  assert.ok(clock() > frozen.clock);
  run(2);

  step(["select"]);
  assert.equal(byte("mode"), 1);
  run(2);
  step(["select"]);
  assert.equal(byte("mode"), 0);
  run(2);

  const steer = (targetX, targetZ, move) => {
    const wanted = Math.round(Math.atan2(targetX - coordinate("x"), targetZ - coordinate("z")) * 128 / Math.PI) & 255;
    const delta = (wanted - byte("angle")) & 255;
    const names = delta ? [delta < 128 ? "right" : "left"] : [];
    if (move && (delta <= 1 || delta === 255)) names.push("up");
    return names;
  };
  for (const [x, z] of [[52, 248], [80, 248], [80, 288], [84, 292], [84, 300], [96, 312], [140, 312], [140, 320]]) {
    until(`walk to ${x},${z}`, () => Math.hypot(x * 256 - coordinate("x"), z * 256 - coordinate("z")) <= 0.6 * 256,
      () => steer(x * 256, z * 256, true), 1500);
    assert.ok(byte("health") > 0);
  }
  until("visible first soldier", () => byte("enemyTarget") !== 0,
    () => steer(coordinate("enemyX"), coordinate("enemyZ"), false));
  snapshots.encounter = state();
  assert.equal(byte("enemyHp"), 3);
  until("soldier attack", () => byte("health") <= 90, [], 1800);
  until("three-hit soldier defeat", () => byte("enemyHp") === 0, () => {
    const names = steer(coordinate("enemyX"), coordinate("enemyZ"), false);
    if (byte("enemyTarget") !== 0 && byte("visibleAngle") === byte("angle") &&
        byte("visibleEnemyEpoch") === byte("enemyEpoch")) names.push("b");
    return names;
  }, 1800);
  assert.equal(byte("hits"), 3);
  assert.equal(byte("kills"), 1);
  assert.equal(word("shots"), 3);
  assert.equal(byte("ammo"), 3);
  assert.ok(byte("corpse") > 0, "Defeat enters the temporary corpse state");
  assert.ok(byte("health") > 0);
  run(2);
  snapshots.afterCombat = state();

  const walk = (x, z) => {
    until(`walk to ${x},${z}`, () => Math.hypot(x * 256 - coordinate("x"), z * 256 - coordinate("z")) <= 0.6 * 256,
      () => steer(x * 256, z * 256, true), 1800);
    assert.ok(byte("health") > 0, "Player survives traversal");
  };
  const face = (angle) => until(`face ${angle}`, () => byte("angle") === angle, () => {
    const delta = (angle - byte("angle")) & 255;
    return [delta < 128 ? "right" : "left"];
  }, 600);

  // Deliberately spend the remaining three rounds into an empty wall, then
  // verify the new click without changing ammunition, shots, hits or kills.
  face(192);
  until("spend last three rounds", () => byte("ammo") === 0, ["b"]);
  until("last gunshot tail ends", () => byte("cooldown") === 0 && byte("fireTimer") === 0, []);
  assert.equal(word("shots"), 6);
  const dryAccounting = [byte("ammo"), word("shots"), byte("hits"), byte("kills")];
  step(["b"]);
  assert.equal(byte("fireTimer"), 0x82);
  assert.equal(byte("cooldown"), 15);
  step(["start", "b"]);
  assert.equal(byte("paused"), 1);
  const dryPaused = state();
  run(30, ["start", "b"]);
  assert.deepEqual(state(), dryPaused, "Pause freezes the short click as well as gameplay");
  run(2);
  step(["start"]);
  assert.equal(byte("paused"), 0);
  assert.deepEqual(state(), dryPaused);
  run(2);
  assert.equal(byte("fireTimer"), 0, "The click stops after two resumed active ticks");
  assert.deepEqual([byte("ammo"), word("shots"), byte("hits"), byte("kills")], dryAccounting);
  snapshots.emptyClick = state();

  walk(144, 344);
  assert.ok(byte("pickups") & 0x80, "Medkit collected while injured");
  assert.equal(byte("health"), 100);
  for (const [x, z] of [[144, 296], [228, 296], [244, 296], [264, 290], [288, 272], [290, 256], [274, 252]]) walk(x, z);
  assert.equal(byte("activeEncounter"), 1);
  assert.ok(byte("pickups") & 0x40, "The tighter clip can be collected from the dry entrance");
  assert.equal(byte("ammo"), 10, "Zero ammunition is replenished before the second fight");
  snapshots.ammoPickup = state();
  for (const [x, z] of [[290, 252], [296, 250]]) walk(x, z);
  until("second three-hit soldier defeat", () => byte("enemyHp") === 0, () => {
    const names = steer(coordinate("enemyX"), coordinate("enemyZ"), false);
    if (byte("enemyTarget") !== 0 && byte("visibleAngle") === byte("angle") &&
        byte("visibleEnemyEpoch") === byte("enemyEpoch")) names.push("b");
    return names;
  }, 2400);
  assert.equal(byte("kills"), 2);
  assert.equal(byte("hits"), 6);
  assert.equal(word("shots"), 9);
  assert.equal(byte("ammo"), 7);
  snapshots.secondCombat = state();

  for (const [x, z] of [[296, 224], [308, 206], [296, 180], [296, 166], [296, 136], [296, 124]]) walk(x, z);
  face(128);
  run(2);
  step(["a"]);
  assert.equal(byte("door"), 1, "Fresh A requests the door");
  until("door actually opens", () => byte("door") === 2 && byte("visibleDoor") === 1, ["up"]);
  for (const [x, z] of [[296, 116], [296, 92], [296, 60], [296, 44], [296, 28], [293, 33]]) walk(x, z);
  face(174); // Both position and angle are newly within the wider exit zone.
  run(2);
  assert.equal(byte("results"), 0);
  step(["a"]);
  assert.ok(byte("exitFlags") & 0x80);
  until("completion screen", () => byte("results") === 5, []);
  assert.equal(byte("resultKills"), 2);
  assert.equal(byte("resultItems"), 2);
  assert.ok(clock() > 0);
  snapshots.completion = state();
  run(180, ["start"]);
  assert.equal(byte("title"), 0, "Completion restart returns directly to gameplay");
  assert.equal(byte("paused"), 0, "Held restart Start must not pause the new game");
  assert.equal(byte("health"), 100);
  assert.equal(byte("ammo"), 6);
  assert.equal(word("shots"), 0);
  assert.equal(byte("kills"), 0);
  assert.equal(byte("pickups"), 0);
  assert.equal(byte("door"), 0);
  snapshots.restart = state();
  assert.ok(generatedPictures >= frame - 2);
  assert.ok(audioSamples > 0 && nonzeroAudioSamples > 0);
  t.diagnostic(JSON.stringify({
    romSha256: releaseSha256, jsnesCommit: coreCommit, frames: frame,
    launchToFirstPictureFrames: firstPictureFrame - launchFrame,
    mapper: "MMC1", chr: "RAM", generatedPictures, audioSamples,
    controllerOnly: true, stockTiming: true, snapshots,
  }));
});

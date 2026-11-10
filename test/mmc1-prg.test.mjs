import assert from "node:assert/strict";
import test from "node:test";
import { NES } from "jsnes";
import { installMmc1PrgCorrection } from "../src/mmc1-prg.js";
import { cartridge, serial, bankPair } from "./support/mmc1-rom.mjs";

function machine(options) {
  const nes = new NES({ emulateSound: false });
  nes.loadROM(cartridge(options));
  return nes;
}

test("32 KiB bank selection reproduces the pinned core error and applies its correction", () => {
  const nes = machine();
  serial(nes.mmap, 0x8000, 3);
  serial(nes.mmap, 0xe000, 4);
  assert.deepEqual(bankPair(nes), [0, 1], "pinned core incorrectly doubles bank 4");
  assert.equal(installMmc1PrgCorrection(nes), true);
  serial(nes.mmap, 0xe000, 4);
  assert.deepEqual(bankPair(nes), [4, 5]);
});

test("all PRG register values work in all four modes for standard MMC1 capacities", () => {
  for (const banks of [1, 2, 4, 8, 16]) {
    const nes = machine({ banks });
    installMmc1PrgCorrection(nes);
    for (let mode = 0; mode < 4; mode++) {
      serial(nes.mmap, 0x8000, (mode << 2) | 3);
      for (let value = 0; value < 32; value++) {
        serial(nes.mmap, 0xe000, value);
        const bank = value & 15;
        const expected = mode < 2 ? [bank & 14, (bank & 14) + 1]
          : mode === 2 ? [0, bank] : [bank, banks - 1];
        assert.deepEqual(bankPair(nes), expected.map((b) => b % banks), `banks ${banks}, mode ${mode}, value ${value}`);
        assert.equal(nes.mmap.romBankSelect, value);
      }
    }
  }
});

test("control changes remap both windows using the retained raw PRG register", () => {
  const nes = machine();
  installMmc1PrgCorrection(nes);
  serial(nes.mmap, 0xe000, 5);
  for (const [control, expected] of [[3, [4, 5]], [11, [0, 5]], [15, [5, 7]], [7, [4, 5]]]) {
    serial(nes.mmap, 0x8000, control);
    assert.deepEqual(bankPair(nes), expected);
    assert.equal(nes.mmap.romBankSelect, 5);
  }
});

test("bit-seven reset at every mapper address clears partial writes and fixes the upper window", () => {
  const nes = machine();
  installMmc1PrgCorrection(nes);
  for (const address of [0x8000, 0x9fff, 0xa000, 0xbfff, 0xc000, 0xdfff, 0xe000, 0xffff]) {
    serial(nes.mmap, 0x8000, 3);
    serial(nes.mmap, 0xe000, 4);
    nes.mmap.write(0xe000, 1);
    nes.mmap.write(address, 0x80);
    assert.equal(nes.mmap.regBufferCounter, 0);
    assert.equal(nes.mmap.regBuffer, 0);
    assert.deepEqual(bankPair(nes), [4, 7]);
    serial(nes.mmap, 0xe000, 2);
    assert.deepEqual(bankPair(nes), [2, 7]);
  }
});

test("reset and save-state mapper recreation retain the correction", () => {
  const nes = machine();
  installMmc1PrgCorrection(nes);
  const originalWrite = nes.mmap.write;
  installMmc1PrgCorrection(nes);
  assert.equal(nes.mmap.write, originalWrite, "installation is idempotent");
  serial(nes.mmap, 0x8000, 3);
  serial(nes.mmap, 0xe000, 5);
  nes.mmap.write(0xe000, 0);
  nes.mmap.write(0xe000, 1);
  const state = nes.toJSON();
  serial(nes.mmap, 0x8000, 15);
  nes.fromJSON(state);
  assert.deepEqual(bankPair(nes), [4, 5]);
  assert.equal(nes.mmap.romBankSelect, 5);
  for (const bit of [1, 0, 0]) nes.mmap.write(0xe000, bit);
  assert.deepEqual(bankPair(nes), [6, 7]);
  serial(nes.mmap, 0x8000, 11);
  assert.deepEqual(bankPair(nes), [0, 6]);
  nes.reset();
  nes.mmap.loadROM();
  serial(nes.mmap, 0x8000, 3);
  serial(nes.mmap, 0xe000, 2);
  assert.deepEqual(bankPair(nes), [2, 3]);
});

test("CHR, mirroring and RAM handlers retain the pinned core behavior", () => {
  const original = machine({ chrBanks: 4 });
  const corrected = machine({ chrBanks: 4 });
  installMmc1PrgCorrection(corrected);
  for (const control of [0, 1, 2, 3, 16, 17, 18, 19]) {
    for (const nes of [original, corrected]) serial(nes.mmap, 0x8000, control);
    assert.deepEqual(corrected.ppu.vramMirrorTable, original.ppu.vramMirrorTable);
    for (const address of [0xa000, 0xc000]) {
      for (const value of [0, 1, 2, 7, 16, 31]) {
        for (const nes of [original, corrected]) serial(nes.mmap, address, value);
        assert.deepEqual(corrected.ppu.vramMem.slice(0, 0x2000), original.ppu.vramMem.slice(0, 0x2000));
      }
    }
  }
  corrected.mmap.write(0x6000, 0x42);
  assert.equal(corrected.cpu.mem[0x6000], 0x42);
});

test("other mappers and extended MMC1 boards retain their existing handlers", () => {
  for (const options of [{ mapper: 0, banks: 2 }, { mapper: 1, banks: 32 }]) {
    const nes = machine(options);
    const write = nes.mmap.write;
    const factory = nes.rom.createMapper;
    assert.equal(installMmc1PrgCorrection(nes), false);
    assert.equal(nes.mmap.write, write);
    assert.equal(nes.rom.createMapper, factory);
  }
});

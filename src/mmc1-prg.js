// PRG banking correction for the pinned JSNES MMC1 implementation.
// Standard MMC1 boards address up to 256 KiB through the four low PRG bits.
// Larger boards reuse CHR pins for outer banking and retain the core's handling.
// See https://www.nesdev.org/wiki/MMC1#PRG_bank_(internal,_$E000-$FFFF)
const patchedRoms = new WeakSet();
const patchedMappers = new WeakSet();

function correctMapper(mapper, rom) {
  if (patchedMappers.has(mapper)) return mapper;
  patchedMappers.add(mapper);
  const setReg = mapper.setReg;
  const write = mapper.write;

  function mapPrg() {
    const bank = mapper.romBankSelect & 0x0f;
    if (mapper.prgSwitchingSize === 0) {
      // load32kRomBank expects a 32 KiB index. The register holds 16 KiB units.
      mapper.load32kRomBank(bank >> 1, 0x8000);
    } else if (mapper.prgSwitchingArea === 0) {
      mapper.loadRomBank(0, 0x8000);
      mapper.loadRomBank(bank, 0xc000);
    } else {
      mapper.loadRomBank(bank, 0x8000);
      mapper.loadRomBank(rom.romCount - 1, 0xc000);
    }
  }

  mapper.setReg = function (register, value) {
    if (register === 3) {
      // The existing serializer already includes this raw register field.
      this.romBankSelect = value & 0x1f;
      mapPrg();
      return;
    }
    setReg.call(this, register, value);
    if (register === 0) mapPrg();
  };

  mapper.write = function (address, value) {
    if (address >= 0x8000 && (value & 0x80)) {
      // A serial reset at any mapper address forces fixed-last 16 KiB mode.
      this.regBuffer = 0;
      this.regBufferCounter = 0;
      this.prgSwitchingArea = 1;
      this.prgSwitchingSize = 1;
      mapPrg();
      return;
    }
    write.call(this, address, value);
  };
  return mapper;
}

export function installMmc1PrgCorrection(nes) {
  const rom = nes.rom;
  if (!rom || rom.mapperType !== 1 || rom.romCount > 16) return false;
  if (!patchedRoms.has(rom)) {
    const createMapper = rom.createMapper;
    // NES.reset/fromJSON recreate the mapper. Keep the correction on that path.
    rom.createMapper = function () {
      return correctMapper(createMapper.call(this), this);
    };
    patchedRoms.add(rom);
  }
  correctMapper(nes.mmap, rom);
  return true;
}

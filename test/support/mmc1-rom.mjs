// A generated diagnostic cartridge with a distinct marker in each PRG bank.
export function cartridge({ banks = 8, mapper = 1, chrBanks = 0 } = {}) {
  const rom = Buffer.alloc(16 + banks * 0x4000 + chrBanks * 0x2000);
  rom.set([0x4e, 0x45, 0x53, 0x1a, banks, chrBanks, mapper << 4, 0, 1]);
  for (let bank = 0; bank < banks; bank++) {
    const offset = 16 + bank * 0x4000;
    rom.fill(bank, offset, offset + 0x4000);
    rom.set([0x4c, 0x00, 0x80], offset); // JMP $8000
    rom.set([0x00, 0x80, 0x00, 0x80, 0x00, 0x80], offset + 0x3ffa);
  }
  for (let bank = 0; bank < chrBanks * 2; bank++) {
    const offset = 16 + banks * 0x4000 + bank * 0x1000;
    rom.fill(0xa0 + bank, offset, offset + 0x1000);
  }
  return rom.toString("latin1");
}

export function serial(mapper, address, value) {
  for (let bit = 0; bit < 5; bit++) mapper.write(address, (value >> bit) & 1);
}

export function bankPair(nes) {
  return [nes.cpu.mem[0x9000], nes.cpu.mem[0xd000]];
}

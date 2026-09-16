/**
 * Fingerprint recovered from a byte-identical, twice-read full-flash backup of
 * the 16K-pressure S620 revision. This is intentionally separate from the
 * original S620 adapter: both revisions enumerate as 256c:006f in normal mode.
 */
export const S620_16K = {
  id: "gaomon-s620-16k",
  displayName: "Gaomon S620 (16K)",
  normal: {
    vendorId: 0x256c,
    productId: 0x006f,
    usagePage: 0xff00,
    inputReportLength: 12,
    deviceStringIndex: 0xc9,
    deviceStringPattern: "GM001_T263_\\d{6}$",
    calibrationStringIndex: 0xc8,
  },
  dfu: {
    vendorId: 0x28e9,
    productId: 0x0189,
    interfaceNumber: 0,
    transferSize: 0x400,
  },
  flash: {
    base: 0x08000000,
    end: 0x08020000,
    pageSize: 0x400,
    appBase: 0x08004000,
    appLength: 0x8d24,
    appEnd: 0x0800cd24,
    extensionBase: 0x0800d000,
    persistenceBase: 0x0800f800,
    protectedTailBase: 0x0800fc00,
  },
  firmware: {
    buildId: "GM001_T263_260527",
    stockAppSha256: "ec124d9675d3f35bb49f81b7e5f82f1dcada43f16d13d61fd571e3c87974212d",
    fullBackupSha256: "75849255b246dcffc4afa24a80ae33d0297e0caca81fd0c98fd9f0ea161db498",
    protocolModelId: 0x1620,
    protocolStockFirmwareId: 0x00260527,
  },
  digitizer: {
    maxX: 33020,
    maxY: 20320,
    maxPressure: 16383,
  },
} as const;

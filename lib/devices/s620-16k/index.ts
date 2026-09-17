import { FRAME_SIZE, REPORT_ID } from "../../firmware/protocol";
import type { DeviceAdapter } from "../types";
import { S620_16K } from "./fingerprint";
import { S62016KPatchBuilder } from "./patches";

const MIN_HZ = 294;
const MAX_HZ = 550;

export const s62016k: DeviceAdapter = {
  id: S620_16K.id,
  displayName: "s620-16k (experimental)",
  normal: {
    vendorId: S620_16K.normal.vendorId,
    productId: S620_16K.normal.productId,
    usagePage: S620_16K.normal.usagePage,
  },
  firmware: {
    buildId: S620_16K.firmware.buildId,
    versionStringIndex: S620_16K.normal.deviceStringIndex,
    calibrationStringIndex: S620_16K.normal.calibrationStringIndex,
    stockAppSha256: S620_16K.firmware.stockAppSha256,
    modelId: S620_16K.firmware.protocolModelId,
    stockFirmwareId: S620_16K.firmware.protocolStockFirmwareId,
  },
  flash: {
    flashBase: S620_16K.flash.base,
    flashEnd: S620_16K.flash.end,
    pageSize: S620_16K.flash.pageSize,
    appBase: S620_16K.flash.appBase,
    appLength: S620_16K.flash.appLength,
    extensionBase: S620_16K.flash.extensionBase,
    persistenceBase: S620_16K.flash.persistenceBase,
    protected: [
      {
        start: S620_16K.flash.base,
        end: S620_16K.flash.appBase,
        label: "resident bootloader",
        reason: "the DFU bootloader is the recovery path and is never modified",
      },
      {
        start: S620_16K.flash.persistenceBase,
        end: S620_16K.flash.end,
        label: "persistence / protected tail",
        reason: "the experimental 16K port does not write persistent configuration or factory tail data",
      },
    ],
  },
  protocol: {
    reportId: REPORT_ID,
    frameSize: FRAME_SIZE,
    usagePage: S620_16K.normal.usagePage,
    penReportId: 0x08,
  },
  dfu: {
    kind: "dfuse",
    identity: {
      vendorId: S620_16K.dfu.vendorId,
      productId: S620_16K.dfu.productId,
    },
    interfaceNumber: S620_16K.dfu.interfaceNumber,
    defaultTransferSize: S620_16K.dfu.transferSize,
    windowsDeviceName: "GD32 Device in DFU Mode",
  },
  rate: {
    minHz: MIN_HZ,
    maxHz: MAX_HZ,
    stepHz: 1,
    measuredCeilingHz: null,
    experimentalMaxHz: MAX_HZ,
    experimentalFromHz: MAX_HZ,
    landmarks: [
      { hz: MIN_HZ, label: "stock timing", evidence: "stock", note: "stock-compatible acquisition delay budget" },
      {
        hz: MAX_HZ,
        label: "experimental target",
        evidence: "experimental",
        note: "aggressive 16K timing target; use the live actual-Hz meter for observed rate",
      },
    ],
  },
  release: {
    label: "S620 16K experimental 550",
    settleUs: [],
    measuredHz: 0,
    sigmaX: 0,
    sigmaY: 0,
    duplicatePct: 0,
    stationaryJumps: 0,
    untested: ["550 Hz endpoint measurement", "pressure/noise sweep", "long-run stability"],
  },
  patches: new S62016KPatchBuilder(),
};

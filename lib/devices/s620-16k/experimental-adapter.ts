import type { DeviceAdapter, PatchBuilder } from "../types";
import { FRAME_SIZE, REPORT_ID } from "../../firmware/protocol";
import { S620_16K } from "./fingerprint";
import { VERIFIED_PROTOCOL_HOOKS } from "./runtime-port";

const disabledPatchBuilder: PatchBuilder = {
  describe: () => VERIFIED_PROTOCOL_HOOKS,
  build: () => {
    throw new Error("S620 16K is experimental-only; use the /experimental guarded bring-up flow");
  },
};

/**
 * Transport/identity adapter for the isolated S620 16K bring-up page.
 *
 * This adapter is intentionally NOT registered in ADAPTERS. The normal installer
 * must not discover it until the protocol-only hardware test has passed and a
 * proper production patch builder/timing model exists.
 */
export const S620_16K_EXPERIMENTAL_ADAPTER: DeviceAdapter = {
  id: S620_16K.id,
  displayName: S620_16K.displayName,
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
        start: S620_16K.flash.protectedTailBase,
        end: S620_16K.flash.end,
        label: "protected flash tail",
        reason: "the experimental port never writes the final flash page",
      },
    ],
  },
  protocol: {
    reportId: REPORT_ID,
    frameSize: FRAME_SIZE,
    usagePage: S620_16K.normal.usagePage,
    penReportId: 0x08,
  },
  // These bounds are protocol-compatibility placeholders only. The experimental
  // page never changes timing and never presents them as measured 16K limits.
  rate: {
    minHz: 1,
    maxHz: 1000,
    stepHz: 1,
    measuredCeilingHz: null,
    experimentalMaxHz: 1000,
    experimentalFromHz: 1,
    landmarks: [],
  },
  release: {
    label: "S620 16K protocol-only bring-up",
    settleUs: [],
    measuredHz: 0,
    sigmaX: 0,
    sigmaY: 0,
    duplicatePct: 0,
    stationaryJumps: 0,
    untested: ["all timing changes", "smoothing", "barrel-button acceleration", "persistence writes"],
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
  patches: disabledPatchBuilder,
};

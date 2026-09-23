import type { DeviceAdapter } from "./types";
import { s620 } from "./s620";
import { s62016k } from "./s620-16k";

/**
 * Supported device adapters. Adding a tablet means adding an adapter here, not
 * editing the installer or configurator.
 */
export type FixedFirmwareImage = {
  label: string;
  parts: readonly string[];
  bytes: number;
  sha256: string;
};

export const s620Stable600: DeviceAdapter = {
  ...s620,
  id: "gaomon-s620-stable-600-nocfg",
  displayName: "s620 STABLE 600hz nocfg",
  release: {
    ...s620.release,
    label: "s620 STABLE 600hz nocfg",
    measuredHz: 600,
  },
};

const FIXED_FIRMWARE = new Map<string, FixedFirmwareImage>([
  [
    s620Stable600.id,
    {
      label: "s620 STABLE 600hz nocfg",
      parts: [
        "/firmware/s620-stable-600-nocfg/0.dat",
        "/firmware/s620-stable-600-nocfg/1.dat",
        "/firmware/s620-stable-600-nocfg/2.dat",
        "/firmware/s620-stable-600-nocfg/3.dat",
        "/firmware/s620-stable-600-nocfg/4.dat",
        "/firmware/s620-stable-600-nocfg/5.dat",
      ],
      bytes: 24_180,
      sha256: "93e33b341aa5d63eb6b032e906dd88481eb623ccf433301676f6097826118377",
    },
  ],
]);

export function fixedFirmwareForAdapter(adapter: DeviceAdapter | null): FixedFirmwareImage | null {
  return adapter ? FIXED_FIRMWARE.get(adapter.id) ?? null : null;
}

export const ADAPTERS: readonly DeviceAdapter[] = [s620, s620Stable600, s62016k];

export const DEFAULT_ADAPTER = s620;

export function adapterForNormalIds(vendorId: number, productId: number): DeviceAdapter | null {
  return (
    ADAPTERS.find(
      (adapter) => adapter.normal.vendorId === vendorId && adapter.normal.productId === productId,
    ) ?? null
  );
}

export function adapterForDfuIds(vendorId: number, productId: number): DeviceAdapter | null {
  return (
    ADAPTERS.find(
      (adapter) => adapter.dfu.identity.vendorId === vendorId && adapter.dfu.identity.productId === productId,
    ) ?? null
  );
}

/** Slider maximum: the measured ceiling once known, the research endpoint until then. */
export function sliderMaxHz(adapter: DeviceAdapter): number {
  return adapter.rate.measuredCeilingHz ?? adapter.rate.experimentalMaxHz;
}

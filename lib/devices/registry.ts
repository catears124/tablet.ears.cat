import type { DeviceAdapter } from "./types";
import { s620 } from "./s620";
import { s62016k } from "./s620-16k";

/**
 * Supported device adapters. Adding a tablet means adding an adapter here, not
 * editing the installer or configurator.
 */
export const ADAPTERS: readonly DeviceAdapter[] = [s620, s62016k];

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

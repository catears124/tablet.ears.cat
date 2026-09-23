import type { BuildResult, PatchBuilder, PatchSite } from "../types";
import { S620_16K } from "./fingerprint";
import { S620_16K_PERFORMANCE_HOOKS, buildS62016KPerformanceRuntimeBlob } from "./performance";

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function applySite(app: Uint8Array, site: PatchSite): void {
  const offset = site.address - S620_16K.flash.appBase;
  if (offset < 0 || offset + site.before.length > app.length) {
    throw new Error(`S620 16K patch 0x${site.address.toString(16)} is outside the pinned application`);
  }
  if (site.before.length !== site.after.length) {
    throw new Error(`S620 16K patch 0x${site.address.toString(16)} changes instruction length`);
  }
  const found = app.slice(offset, offset + site.before.length);
  if (bytesHex(found) !== bytesHex(site.before)) {
    throw new Error(
      `${site.purpose}: preimage mismatch at 0x${site.address.toString(16)}; expected ${bytesHex(site.before)}, found ${bytesHex(found)}`,
    );
  }
  app.set(site.after, offset);
}

export class S62016KPatchBuilder implements PatchBuilder {
  describe(): readonly PatchSite[] {
    return S620_16K_PERFORMANCE_HOOKS;
  }

  build(stockApp: Uint8Array): BuildResult {
    if (stockApp.length !== S620_16K.flash.appLength) {
      throw new Error(`S620 16K stock application is ${stockApp.length} bytes, expected ${S620_16K.flash.appLength}`);
    }

    const runtime = buildS62016KPerformanceRuntimeBlob();
    const runtimeEnd = S620_16K.flash.extensionBase + runtime.length;
    if (S620_16K.flash.extensionBase < S620_16K.flash.appEnd) {
      throw new Error("S620 16K runtime overlaps the stock application");
    }
    if (runtimeEnd > S620_16K.flash.persistenceBase) {
      throw new Error("S620 16K runtime overlaps persistence flash");
    }

    const image = new Uint8Array(S620_16K.flash.extensionBase - S620_16K.flash.appBase + runtime.length);
    image.fill(0xff);
    image.set(stockApp, 0);
    const app = image.subarray(0, S620_16K.flash.appLength);
    for (const site of S620_16K_PERFORMANCE_HOOKS) applySite(app, site);
    image.set(runtime, S620_16K.flash.extensionBase - S620_16K.flash.appBase);

    return {
      app: image,
      sites: S620_16K_PERFORMANCE_HOOKS,
      appended: [
        {
          start: S620_16K.flash.extensionBase,
          end: runtimeEnd,
          label: "S620 16K runtime",
          reason: "relocated live configuration, no-smoothing and timing-control runtime",
        },
      ],
    };
  }
}

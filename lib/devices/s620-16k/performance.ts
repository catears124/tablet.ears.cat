import type { PatchSite } from "../types";
import { S620_16K } from "./fingerprint";
import {
  S620_16K_RUNTIME_BASE,
  VERIFIED_DATA_PATH_CANDIDATES,
  VERIFIED_PROTOCOL_HOOKS,
  buildS62016KRuntimeResearchBlob,
} from "./runtime-port";

function bytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error("S620 16K performance port contains malformed hex");
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectAt(image: Uint8Array, offset: number, expected: Uint8Array, label: string): void {
  const actual = image.slice(offset, offset + expected.length);
  if (actual.length !== expected.length || bytesHex(actual) !== bytesHex(expected)) {
    throw new Error(`${label}: expected ${bytesHex(expected)} at +0x${offset.toString(16)}, found ${bytesHex(actual)}`);
  }
}

function patchAt(image: Uint8Array, offset: number, beforeHex: string, afterHex: string, label: string): void {
  const before = bytesFromHex(beforeHex);
  const after = bytesFromHex(afterHex);
  if (before.length !== after.length) throw new Error(`${label}: patch must preserve length`);
  expectAt(image, offset, before, label);
  image.set(after, offset);
}

/** Encode a Thumb-2 B.W or BL. `source` is the address of the first halfword. */
function encodeThumb2Branch(source: number, target: number, link: boolean): Uint8Array {
  const delta = target - (source + 4);
  if ((delta & 1) !== 0 || delta < -(1 << 24) || delta >= 1 << 24) {
    throw new Error(`branch ${source.toString(16)} -> ${target.toString(16)} is not encodable`);
  }

  const imm25 = delta & 0x1ffffff;
  const s = (imm25 >>> 24) & 1;
  const i1 = (imm25 >>> 23) & 1;
  const i2 = (imm25 >>> 22) & 1;
  const imm10 = (imm25 >>> 12) & 0x3ff;
  const imm11 = (imm25 >>> 1) & 0x7ff;
  const j1 = (~(i1 ^ s)) & 1;
  const j2 = (~(i2 ^ s)) & 1;
  const first = 0xf000 | (s << 10) | imm10;
  const second = (link ? 0xd000 : 0x9000) | (j1 << 13) | (j2 << 11) | imm11;
  return Uint8Array.from([first & 0xff, first >>> 8, second & 0xff, second >>> 8]);
}

function callHook(address: number, beforeHex: string, runtimeOffset: number, purpose: string): PatchSite {
  return {
    address,
    before: bytesFromHex(beforeHex),
    after: encodeThumb2Branch(address, S620_16K_RUNTIME_BASE + runtimeOffset, true),
    purpose,
  };
}

/*
 * Hand-assembled Thumb wrappers appended after the hardware-validated protocol
 * runtime. Before the live config has initialized, all three preserve stock
 * behavior. Once config is initialized, the default profile is 550 Hz target,
 * exact EMA bypass, one-sample average.
 *
 * timing wrapper: map 294..550 to a proportional 227..6 delay budget, then
 * scale each stock delay argument and tail-call the verified 16K delay helper.
 * The host-observed HID meter remains the truth for the achieved physical rate.
 */
const PERFORMANCE_WRAPPERS = bytesFromHex(
  "40f6004cc2f2000c9cf82620002a01d1402201e0ff2a04d044f6c52cc0f6000c60477047" +
  "40f6004cc2f2000c9cf82730002b00d104234af23d2cc0f6000c6047" +
  "034640f60041c2f20001b1f82400002817d040f22611884200d2084640f22621884200d9084640f22621091add2251438031090a06314b437133e322b3fbf2f000e0184646f6973cc0f6000c6047",
);

const RESEARCH_RUNTIME_BYTES = 0x558;
export const S620_16K_SMOOTHING_WRAPPER_OFFSET = RESEARCH_RUNTIME_BYTES;
export const S620_16K_AVERAGE_WRAPPER_OFFSET = RESEARCH_RUNTIME_BYTES + 0x24;
export const S620_16K_TIMING_WRAPPER_OFFSET = RESEARCH_RUNTIME_BYTES + 0x40;

const TIMING_CALLS = [
  { address: 0x08004d90, before: "01f001ff" },
  { address: 0x08004da4, before: "01f0f7fe" },
  { address: 0x08004dde, before: "01f0dafe" },
  { address: 0x08004e10, before: "01f0c1fe" },
  { address: 0x08004e24, before: "01f0b7fe" },
  { address: 0x08004e5e, before: "01f09afe" },
] as const;

/** Build the normal-site experimental 16K runtime. */
export function buildS62016KPerformanceRuntimeBlob(): Uint8Array {
  const research = buildS62016KRuntimeResearchBlob();
  if (research.length !== RESEARCH_RUNTIME_BYTES) {
    throw new Error(`unexpected S620 16K research runtime length 0x${research.length.toString(16)}`);
  }

  // Persistence has not been validated on the 16K revision. Disable command 4
  // and report persistence=0 even though the inherited runtime contains code for it.
  patchAt(research, 0x18a, "042d", "ff2d", "disable SAVE_CONFIG");
  patchAt(research, 0x1ea, "0120", "0020", "GET_INFO persistence flag");

  // GET_INFO / SET_CONFIG / stored-config validation range: 294..550.
  patchAt(research, 0x1e0, "40f21220", "40f22620", "GET_INFO max Hz");
  patchAt(research, 0x280, "40f21222", "40f22622", "SET_CONFIG max compare");
  patchAt(research, 0x288, "40f21220", "40f22620", "SET_CONFIG max clamp");
  patchAt(research, 0x3d8, "40f21222", "40f22622", "stored config max compare");

  // Defaults after config initialization: 550 Hz, exact EMA off, average 1.
  patchAt(research, 0x2f8, "40f22610", "40f22620", "factory default target");
  patchAt(research, 0x2fe, "4020", "ff20", "factory default EMA");
  patchAt(research, 0x304, "0420", "0120", "factory default average");
  patchAt(research, 0x422, "40f22610", "40f22620", "RAM default target");
  patchAt(research, 0x428, "4020", "ff20", "RAM default EMA");
  patchAt(research, 0x42e, "0420", "0120", "RAM default average");

  const out = new Uint8Array(research.length + PERFORMANCE_WRAPPERS.length);
  out.set(research, 0);
  out.set(PERFORMANCE_WRAPPERS, research.length);

  if (S620_16K.flash.extensionBase + out.length > S620_16K.flash.persistenceBase) {
    throw new Error("S620 16K performance runtime overlaps persistence flash");
  }
  return out;
}

const averageHooks = VERIFIED_DATA_PATH_CANDIDATES.averageCalls.map((site) =>
  callHook(site.address, site.before, S620_16K_AVERAGE_WRAPPER_OFFSET, "16K one-to-four-sample moving-average control"),
);

const smoothingHooks = VERIFIED_DATA_PATH_CANDIDATES.smoothingCallsPendingSemanticFix.map((site) => {
  const before = site.address === 0x080077be ? "fdf781f9" : "fdf778f9";
  return callHook(site.address, before, S620_16K_SMOOTHING_WRAPPER_OFFSET, "16K EMA control with exact off path");
});

const timingHooks = TIMING_CALLS.map((site) =>
  callHook(site.address, site.before, S620_16K_TIMING_WRAPPER_OFFSET, "16K acquisition delay scaling for 294..550 Hz target"),
);

const barrelHooks = VERIFIED_DATA_PATH_CANDIDATES.fastBarrelCalls.map((site) =>
  callHook(site.address, site.before, site.runtimeOffset, "16K fast barrel-button control"),
);

export const S620_16K_PERFORMANCE_HOOKS: readonly PatchSite[] = [
  ...VERIFIED_PROTOCOL_HOOKS,
  ...averageHooks,
  ...smoothingHooks,
  ...timingHooks,
  ...barrelHooks,
];

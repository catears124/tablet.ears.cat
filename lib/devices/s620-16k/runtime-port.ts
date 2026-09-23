/**
 * Mechanical part of the S620 (16K) runtime port.
 *
 * This relocates the already-shipped S620 extension out of the 16K stock image
 * and rebases only external branches whose 16K targets have been matched in
 * disassembly. It deliberately does NOT make the result production-flashable:
 * timing and smoothing differ on this firmware and their stock hook sites are
 * not enabled by the original protocol bring-up.
 */

import sourceManifest from "../s620/runtime.json";
import type { PatchSite } from "../types";
import { S620_16K } from "./fingerprint";

const OLD_RUNTIME_BASE = 0x0800cc00;
export const S620_16K_RUNTIME_BASE = S620_16K.flash.extensionBase;

function bytesFromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) {
    throw new Error("runtime port contains malformed hex");
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

/** Encode a Thumb-2 B.W or BL. source is the address of the first halfword. */
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

type BranchPort = {
  offset: number;
  link: boolean;
  oldTarget: number;
  newTarget: number;
  purpose: string;
};

/**
 * External calls made by the old runtime. Every newTarget below was matched to
 * its 16K counterpart from stock-firmware disassembly. Internal branches need
 * no rewrite when the whole blob moves by a constant delta.
 */
export const VERIFIED_RUNTIME_BRANCH_PORTS: readonly BranchPort[] = [
  { offset: 0x016, link: true, oldTarget: 0x0800af00, newTarget: 0x0800b0e0, purpose: "feature-report helper" },
  { offset: 0x01a, link: false, oldTarget: 0x0800b6d0, newTarget: 0x0800b8b0, purpose: "feature-report continuation" },
  { offset: 0x02a, link: false, oldTarget: 0x0800b64c, newTarget: 0x0800b82c, purpose: "feature-report fallback" },
  { offset: 0x044, link: true, oldTarget: 0x0800aea4, newTarget: 0x0800b084, purpose: "feature-report helper" },
  { offset: 0x048, link: false, oldTarget: 0x0800b6d0, newTarget: 0x0800b8b0, purpose: "feature-report continuation" },
  { offset: 0x058, link: true, oldTarget: 0x0800aea4, newTarget: 0x0800b084, purpose: "feature-report helper" },
  { offset: 0x05c, link: false, oldTarget: 0x0800b6d0, newTarget: 0x0800b8b0, purpose: "feature-report continuation" },
  { offset: 0x082, link: false, oldTarget: 0x0800b7bc, newTarget: 0x0800b99c, purpose: "feature-report dispatch" },
  { offset: 0x08a, link: false, oldTarget: 0x0800b7c4, newTarget: 0x0800b9a4, purpose: "feature-report dispatch" },
  { offset: 0x0a2, link: false, oldTarget: 0x08004a90, newTarget: 0x08004ac4, purpose: "smoothing helper (wrapper not hooked yet)" },
  { offset: 0x0ba, link: false, oldTarget: 0x0800a04c, newTarget: 0x0800a23c, purpose: "average helper (wrapper not hooked yet)" },
  { offset: 0x112, link: false, oldTarget: 0x08006b2e, newTarget: 0x08006b96, purpose: "delay helper (timing wrapper not hooked yet)" },
  { offset: 0x118, link: false, oldTarget: 0x08006b2e, newTarget: 0x08006b96, purpose: "delay helper (timing wrapper not hooked yet)" },
  { offset: 0x11e, link: false, oldTarget: 0x08006b2e, newTarget: 0x08006b96, purpose: "delay helper (timing wrapper not hooked yet)" },
  { offset: 0x138, link: false, oldTarget: 0x08006cb4, newTarget: 0x08006d1c, purpose: "barrel-button helper (wrapper not hooked yet)" },
];

const OLD_DISPATCH_FALLBACK = bytesFromHex("4bf0e283");
// Verified with LLVM: bne.w from 0x0800d07e to the 16K stock continuation 0x0800b9a4.
const PORT_DISPATCH_FALLBACK = bytesFromHex("7ef491ac");
const OLD_MODEL_ID = bytesFromHex("40f22060"); // movw r0,#0x0620
const NEW_MODEL_ID = bytesFromHex("41f22060"); // movw r0,#0x1620
const OLD_STOCK_FIRMWARE_ID = bytesFromHex("41f23000c0f22400"); // 0x00241030
const NEW_STOCK_FIRMWARE_ID = bytesFromHex("40f22750c0f22600"); // 0x00260527
const OLD_CAPABILITIES = bytesFromHex("0b20");
const PORT_CAPABILITIES = bytesFromHex("0120"); // LiveConfig only; no persistence/timing claims in bring-up

/**
 * Produce the relocated 16K runtime core. The production performance layer
 * appends the validated timing/filter wrappers before installation.
 */
export function buildS62016KRuntimeResearchBlob(): Uint8Array {
  const manifest = sourceManifest as { base: number; blob: string };
  if (manifest.base !== OLD_RUNTIME_BASE) {
    throw new Error(`unexpected source runtime base 0x${manifest.base.toString(16)}`);
  }

  const blob = bytesFromHex(manifest.blob);

  // This conditional fallback is external control flow too, but the source blob
  // contains a hand-emitted BNE.W rather than one produced by encodeThumb2Branch.
  // Rebase it explicitly before the neighboring unconditional dispatch branches.
  expectAt(blob, 0x07e, OLD_DISPATCH_FALLBACK, "feature-report non-0x16 fallback");
  blob.set(PORT_DISPATCH_FALLBACK, 0x07e);

  for (const port of VERIFIED_RUNTIME_BRANCH_PORTS) {
    const oldInstruction = encodeThumb2Branch(OLD_RUNTIME_BASE + port.offset, port.oldTarget, port.link);
    expectAt(blob, port.offset, oldInstruction, port.purpose);
    const newInstruction = encodeThumb2Branch(S620_16K_RUNTIME_BASE + port.offset, port.newTarget, port.link);
    blob.set(newInstruction, port.offset);
  }

  expectAt(blob, 0x1c2, OLD_MODEL_ID, "GET_INFO model id");
  blob.set(NEW_MODEL_ID, 0x1c2);
  expectAt(blob, 0x1c8, OLD_STOCK_FIRMWARE_ID, "GET_INFO stock firmware id");
  blob.set(NEW_STOCK_FIRMWARE_ID, 0x1c8);
  expectAt(blob, 0x1d4, OLD_CAPABILITIES, "GET_INFO capability flags");
  blob.set(PORT_CAPABILITIES, 0x1d4);

  return blob;
}

function branchHook(address: number, beforeHex: string, runtimeOffset: number, purpose: string): PatchSite {
  const before = bytesFromHex(beforeHex);
  const branch = encodeThumb2Branch(address, S620_16K_RUNTIME_BASE + runtimeOffset, false);
  const after = new Uint8Array(before.length);
  after.set(branch, 0);
  for (let offset = branch.length; offset < after.length; offset += 2) {
    after[offset] = 0x00;
    after[offset + 1] = 0xbf; // nop
  }
  return { address, before, after, purpose };
}

/**
 * Verified stock hook sites needed only to bring up the feature-report protocol.
 * Keeping this list separate is deliberate: no pen-path or timing hooks are
 * enabled in the first hardware test.
 */
export const VERIFIED_PROTOCOL_HOOKS: readonly PatchSite[] = [
  branchHook(0x0800b824, "16208df800000120", 0x004, "route feature-report path into 16K runtime"),
  branchHook(0x0800b884, "08223a492846fff7", 0x032, "route feature-report path into 16K runtime"),
  branchHook(0x0800b994, "1a480078162803d1", 0x064, "route feature-report dispatcher into 16K runtime"),
  {
    address: 0x0800c7e5,
    before: bytesFromHex("9507"),
    after: bytesFromHex("9520"),
    purpose: "expand vendor feature report 0x16 to 32 bytes",
  },
];

/** Mapped data-path sites retained separately from the protocol core. */
export const VERIFIED_DATA_PATH_CANDIDATES = {
  averageCalls: [
    { address: 0x0800766e, before: "02f0e5fd", runtimeOffset: 0x0aa },
    { address: 0x0800767e, before: "02f0ddfd", runtimeOffset: 0x0aa },
  ],
  fastBarrelCalls: [
    { address: 0x0800803c, before: "fef76efe", runtimeOffset: 0x126 },
    { address: 0x080080c0, before: "fef72cfe", runtimeOffset: 0x126 },
  ],
  smoothingCallsPendingSemanticFix: [
    { address: 0x080077be, runtimeOffset: 0x092 },
    { address: 0x080077d0, runtimeOffset: 0x092 },
  ],
} as const;

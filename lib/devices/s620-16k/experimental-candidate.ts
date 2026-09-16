import type { PatchSite } from "../types";
import { sha256Hex } from "../../firmware/image";
import { S620_16K } from "./fingerprint";
import { buildS62016KRuntimeResearchBlob, VERIFIED_PROTOCOL_HOOKS } from "./runtime-port";

export type ExperimentalPageImage = {
  address: number;
  stock: Uint8Array;
  candidate: Uint8Array;
  labels: readonly string[];
};

export type S62016KProtocolCandidate = {
  sourceFullSha256: string;
  sourceAppSha256: string;
  runtime: Uint8Array;
  runtimeAddress: number;
  runtimeEnd: number;
  runtimeWasAlreadyStaged: boolean;
  activationPages: readonly ExperimentalPageImage[];
};

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function isBlank(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0xff) return false;
  return true;
}

function offsetOf(address: number): number {
  return address - S620_16K.flash.base;
}

function pageBase(address: number): number {
  const size = S620_16K.flash.pageSize;
  return address - (address % size);
}

function pageBytes(fullFlash: Uint8Array, address: number): Uint8Array {
  const base = pageBase(address);
  const offset = offsetOf(base);
  return fullFlash.slice(offset, offset + S620_16K.flash.pageSize);
}

function applyPatch(fullFlash: Uint8Array, site: PatchSite): void {
  const offset = offsetOf(site.address);
  const found = fullFlash.slice(offset, offset + site.before.length);
  if (!equal(found, site.before)) {
    throw new Error(
      `${site.purpose}: stock preimage mismatch at ${hex(site.address)}; ` +
        `expected ${[...site.before].map((x) => x.toString(16).padStart(2, "0")).join("")}, ` +
        `found ${[...found].map((x) => x.toString(16).padStart(2, "0")).join("")}`,
    );
  }
  fullFlash.set(site.after, offset);
}

function changedPageAddresses(before: Uint8Array, after: Uint8Array): number[] {
  const out: number[] = [];
  const pageSize = S620_16K.flash.pageSize;
  for (let offset = 0; offset < before.length; offset += pageSize) {
    if (!equal(before.subarray(offset, offset + pageSize), after.subarray(offset, offset + pageSize))) {
      out.push(S620_16K.flash.base + offset);
    }
  }
  return out;
}

function pagesCovered(start: number, end: number): number[] {
  const out: number[] = [];
  const size = S620_16K.flash.pageSize;
  for (let page = pageBase(start); page < end; page += size) out.push(page);
  return out;
}

function assertSameAddressSet(actual: readonly number[], expected: readonly number[], label: string): void {
  const a = [...new Set(actual)].sort((x, y) => x - y);
  const e = [...new Set(expected)].sort((x, y) => x - y);
  if (a.length !== e.length || a.some((value, index) => value !== e[index])) {
    throw new Error(
      `${label}: changed pages ${a.map(hex).join(", ")} do not equal allowed pages ${e.map(hex).join(", ")}`,
    );
  }
}

/**
 * Build the first S620 16K hardware candidate from a freshly-read device image.
 *
 * Safety properties:
 * - exact 128 KiB flash geometry;
 * - exact pinned stock application hash;
 * - all protocol-hook preimages must match;
 * - the relocated runtime must fit entirely before persistence flash;
 * - the runtime destination must be either erased or already byte-identical;
 * - the activation image may change only the two pages containing the four
 *   protocol-only hooks. Pen acquisition/timing/smoothing are untouched.
 */
export async function buildS62016KProtocolCandidate(
  fullFlash: Uint8Array,
): Promise<S62016KProtocolCandidate> {
  const expectedLength = S620_16K.flash.end - S620_16K.flash.base;
  if (fullFlash.length !== expectedLength) {
    throw new Error(`flash image is ${fullFlash.length} bytes, expected ${expectedLength}`);
  }

  const appOffset = offsetOf(S620_16K.flash.appBase);
  const app = fullFlash.slice(appOffset, appOffset + S620_16K.flash.appLength);
  const sourceAppSha256 = await sha256Hex(app);
  if (sourceAppSha256 !== S620_16K.firmware.stockAppSha256) {
    throw new Error(
      `S620 16K stock application mismatch: ${sourceAppSha256}; expected ${S620_16K.firmware.stockAppSha256}`,
    );
  }

  const sourceFullSha256 = await sha256Hex(fullFlash);
  const runtime = buildS62016KRuntimeResearchBlob();
  const runtimeAddress = S620_16K.flash.extensionBase;
  const runtimeEnd = runtimeAddress + runtime.length;
  if (runtimeEnd > S620_16K.flash.persistenceBase) {
    throw new Error(
      `relocated runtime ${hex(runtimeAddress)}..${hex(runtimeEnd)} overlaps persistence at ${hex(S620_16K.flash.persistenceBase)}`,
    );
  }

  const runtimeOffset = offsetOf(runtimeAddress);
  const currentRuntime = fullFlash.slice(runtimeOffset, runtimeOffset + runtime.length);
  const runtimeWasAlreadyStaged = equal(currentRuntime, runtime);
  if (!runtimeWasAlreadyStaged && !isBlank(currentRuntime)) {
    throw new Error(
      `runtime destination ${hex(runtimeAddress)}..${hex(runtimeEnd)} is neither erased nor the exact staged runtime`,
    );
  }

  // Also require untouched bytes from the end of the runtime through the end
  // of its final flash page. The stage operation never needs to erase a page.
  const runtimePageEnd = pageBase(runtimeEnd - 1) + S620_16K.flash.pageSize;
  const tail = fullFlash.slice(offsetOf(runtimeEnd), offsetOf(runtimePageEnd));
  if (!isBlank(tail)) {
    throw new Error(`bytes after the runtime through ${hex(runtimePageEnd)} are not erased`);
  }

  const candidate = fullFlash.slice();
  candidate.set(runtime, runtimeOffset);
  for (const site of VERIFIED_PROTOCOL_HOOKS) applyPatch(candidate, site);

  const hookPages = [...new Set(VERIFIED_PROTOCOL_HOOKS.map((site) => pageBase(site.address)))].sort((a, b) => a - b);
  if (hookPages.length !== 2 || hookPages[0] !== 0x0800b800 || hookPages[1] !== 0x0800c400) {
    throw new Error(`unexpected protocol activation pages: ${hookPages.map(hex).join(", ")}`);
  }

  // Ignore the extension when proving activation locality. The activation step
  // is allowed to touch exactly the two stock pages above and nothing else.
  const activationOnly = fullFlash.slice();
  for (const site of VERIFIED_PROTOCOL_HOOKS) applyPatch(activationOnly, site);
  assertSameAddressSet(changedPageAddresses(fullFlash, activationOnly), hookPages, "protocol-only activation");

  const labelsByPage = new Map<number, string[]>();
  for (const site of VERIFIED_PROTOCOL_HOOKS) {
    const page = pageBase(site.address);
    const labels = labelsByPage.get(page) ?? [];
    labels.push(site.purpose);
    labelsByPage.set(page, labels);
  }

  const activationPages = hookPages.map((address) => ({
    address,
    stock: pageBytes(fullFlash, address),
    candidate: pageBytes(candidate, address),
    labels: labelsByPage.get(address) ?? [],
  }));

  // Global locality assertion: candidate changes are exactly hook pages plus
  // however many erased pages contain the relocated runtime.
  const expectedAllPages = [...hookPages, ...pagesCovered(runtimeAddress, runtimeEnd)];
  assertSameAddressSet(changedPageAddresses(fullFlash, candidate), expectedAllPages, "complete protocol candidate");

  return {
    sourceFullSha256,
    sourceAppSha256,
    runtime,
    runtimeAddress,
    runtimeEnd,
    runtimeWasAlreadyStaged,
    activationPages,
  };
}

export function exactS62016KTestUnit(fullSha256: string): boolean {
  return fullSha256 === S620_16K.firmware.fullBackupSha256;
}

import { S620_16K } from "../devices/s620-16k/fingerprint";
import type { ExperimentalPageImage, S62016KProtocolCandidate } from "../devices/s620-16k/experimental-candidate";
import { sha256Hex } from "../firmware/image";
import { WebUsbDfuDevice } from "./webusb-dfu";

export type ExperimentalWriteProgress = {
  phase: "check" | "erase" | "blank" | "write" | "verify";
  detail: string;
  done: number;
  total: number;
};

const MAX_ERASE_PASSES = 3;

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function blank(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0xff) return false;
  return true;
}

function pageBase(address: number): number {
  const size = S620_16K.flash.pageSize;
  return address - (address % size);
}

function offsetOf(address: number): number {
  return address - S620_16K.flash.base;
}

function pagesCovered(start: number, end: number): number[] {
  const pages: number[] = [];
  const size = S620_16K.flash.pageSize;
  for (let page = pageBase(start); page < end; page += size) pages.push(page);
  return pages;
}

async function writeBytes(
  device: WebUsbDfuDevice,
  address: number,
  data: Uint8Array,
  onProgress?: (progress: ExperimentalWriteProgress) => void,
  label = "write",
): Promise<void> {
  let done = 0;
  while (done < data.length) {
    const end = Math.min(done + device.transferSize, data.length);
    await device.writeBlock(address + done, data.subarray(done, end));
    done = end;
    onProgress?.({ phase: "write", detail: label, done, total: data.length });
  }
}

async function assertDeviceBytes(
  device: WebUsbDfuDevice,
  address: number,
  expected: Uint8Array,
  label: string,
): Promise<void> {
  const current = await device.read(address, expected.length);
  if (!equal(current, expected)) {
    throw new Error(`${label}: device bytes at ${hex(address)} no longer match the verified image`);
  }
}

/**
 * Stage the relocated runtime into a region that was proven erased by the
 * twice-read backup. No erase command is issued and no stock executable byte is
 * changed, so a failed/partial stage cannot redirect execution into the blob.
 */
export async function stageS62016KRuntimeWithoutErase(
  device: WebUsbDfuDevice,
  candidate: S62016KProtocolCandidate,
  onProgress?: (progress: ExperimentalWriteProgress) => void,
): Promise<"written" | "already-staged"> {
  const { runtimeAddress, runtimeEnd, runtime } = candidate;
  if (runtimeAddress !== S620_16K.flash.extensionBase || runtimeEnd > S620_16K.flash.persistenceBase) {
    throw new Error("runtime bounds changed after candidate verification");
  }

  const current = await device.read(runtimeAddress, runtime.length);
  if (equal(current, runtime)) {
    onProgress?.({ phase: "verify", detail: "runtime already staged", done: runtime.length, total: runtime.length });
    return "already-staged";
  }
  if (!blank(current)) {
    throw new Error("runtime destination is no longer erased; refusing no-erase staging");
  }

  onProgress?.({ phase: "check", detail: "runtime destination is erased", done: 1, total: 1 });
  await writeBytes(device, runtimeAddress, runtime, onProgress, "stage inert runtime");
  const readBack = await device.read(runtimeAddress, runtime.length);
  if (!equal(readBack, runtime)) throw new Error("runtime staging read-back mismatch");
  onProgress?.({ phase: "verify", detail: "runtime staged and verified", done: runtime.length, total: runtime.length });
  return "written";
}

async function eraseAndBlankCheckPages(
  device: WebUsbDfuDevice,
  pages: readonly number[],
  onProgress?: (progress: ExperimentalWriteProgress) => void,
): Promise<void> {
  let erased = 0;
  for (const page of pages) {
    await device.erasePage(page);
    erased += 1;
    onProgress?.({ phase: "erase", detail: `erase ${hex(page)}`, done: erased, total: pages.length });
  }

  for (let pass = 1; pass <= MAX_ERASE_PASSES; pass += 1) {
    const dirty: number[] = [];
    let checked = 0;
    for (const page of pages) {
      const data = await device.read(page, S620_16K.flash.pageSize);
      checked += 1;
      onProgress?.({ phase: "blank", detail: `blank check ${hex(page)}`, done: checked, total: pages.length });
      if (!blank(data)) dirty.push(page);
    }
    if (dirty.length === 0) return;
    if (pass === MAX_ERASE_PASSES) {
      throw new Error(`erase failed after ${MAX_ERASE_PASSES} passes: ${dirty.map(hex).join(", ")}`);
    }
    for (const page of dirty) await device.erasePage(page);
  }
}

/**
 * Activate only the protocol path. Call this only in a fresh DFU session after
 * the inert runtime stage has been read back successfully.
 *
 * The two stock pages are both erased before the first program operation. The
 * descriptor page is written first and the page containing all executable
 * feature-report hooks is written last. Pen/timing pages are never erased.
 */
export async function activateS62016KProtocolHooks(
  device: WebUsbDfuDevice,
  candidate: S62016KProtocolCandidate,
  onProgress?: (progress: ExperimentalWriteProgress) => void,
): Promise<void> {
  if (candidate.activationPages.length !== 2) throw new Error("expected exactly two activation pages");

  // Prove the inert extension survived the DFU reconnect before touching stock.
  await assertDeviceBytes(device, candidate.runtimeAddress, candidate.runtime, "staged runtime");

  const byAddress = new Map(candidate.activationPages.map((page) => [page.address, page]));
  const descriptorPage = byAddress.get(0x0800c400);
  const hookPage = byAddress.get(0x0800b800);
  if (!descriptorPage || !hookPage) throw new Error("activation page map changed unexpectedly");

  // Re-validate complete stock pages immediately before the first erase.
  for (const page of [hookPage, descriptorPage]) {
    await assertDeviceBytes(device, page.address, page.stock, `stock activation page ${hex(page.address)}`);
  }
  onProgress?.({ phase: "check", detail: "both stock pages match verified backup", done: 2, total: 2 });

  await eraseAndBlankCheckPages(device, [descriptorPage.address, hookPage.address], onProgress);

  // Non-executable HID descriptor change first; executable branch hooks last.
  await writeBytes(device, descriptorPage.address, descriptorPage.candidate, onProgress, "write descriptor page");
  await writeBytes(device, hookPage.address, hookPage.candidate, onProgress, "write executable hook page last");

  for (const page of [descriptorPage, hookPage]) {
    const readBack = await device.read(page.address, S620_16K.flash.pageSize);
    if (!equal(readBack, page.candidate)) {
      throw new Error(`activation read-back mismatch at ${hex(page.address)}; re-enter DFU and use restore`);
    }
  }
  onProgress?.({ phase: "verify", detail: "protocol-only activation verified", done: 2, total: 2 });
}

/**
 * Restore every page touched by the experiment from the exact pre-test backup.
 * This intentionally accepts any current contents in those pages so it remains
 * usable after an interrupted/partial activation. The supplied backup itself is
 * accepted only if its full-image SHA-256 matches the pinned test-unit backup.
 */
export async function restoreS62016KExperimentalPages(
  device: WebUsbDfuDevice,
  stockBackup: Uint8Array,
  candidate: S62016KProtocolCandidate,
  onProgress?: (progress: ExperimentalWriteProgress) => void,
): Promise<void> {
  const expectedLength = S620_16K.flash.end - S620_16K.flash.base;
  if (stockBackup.length !== expectedLength) throw new Error("recovery backup has the wrong length");
  const hash = await sha256Hex(stockBackup);
  if (hash !== S620_16K.firmware.fullBackupSha256) {
    throw new Error(`recovery backup hash ${hash} is not the pinned pre-test backup`);
  }

  const hookPages = candidate.activationPages.map((page) => page.address);
  const runtimePages = pagesCovered(candidate.runtimeAddress, candidate.runtimeEnd);
  const pages = [...new Set([...hookPages, ...runtimePages])].sort((a, b) => a - b);
  for (const page of pages) {
    if (page < S620_16K.flash.appBase || page >= S620_16K.flash.protectedTailBase) {
      throw new Error(`recovery page ${hex(page)} is outside the experimental write window`);
    }
  }

  await eraseAndBlankCheckPages(device, pages, onProgress);

  // Runtime pages were 0xFF in the pinned stock backup, so they remain erased.
  // Reprogram only stock pages that contain non-FF bytes.
  let written = 0;
  for (const page of pages) {
    const stock = stockBackup.slice(offsetOf(page), offsetOf(page) + S620_16K.flash.pageSize);
    if (!blank(stock)) await writeBytes(device, page, stock, onProgress, `restore ${hex(page)}`);
    written += 1;
    onProgress?.({ phase: "write", detail: `restore page ${hex(page)}`, done: written, total: pages.length });
  }

  let verified = 0;
  for (const page of pages) {
    const expected = stockBackup.slice(offsetOf(page), offsetOf(page) + S620_16K.flash.pageSize);
    const readBack = await device.read(page, S620_16K.flash.pageSize);
    if (!equal(readBack, expected)) throw new Error(`restore read-back mismatch at ${hex(page)}`);
    verified += 1;
    onProgress?.({ phase: "verify", detail: `verify restored ${hex(page)}`, done: verified, total: pages.length });
  }
}

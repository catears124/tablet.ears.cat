"use client";

import { useEffect, useRef, useState } from "react";
import { s620 } from "@/lib/devices/s620";
import { planFlash } from "@/lib/firmware/flashplan";
import { sha256Hex } from "@/lib/firmware/image";
import { writeAndVerify, type FlashProgress } from "@/lib/transport/flash-writer";
import { WebUsbDfuDevice } from "@/lib/transport/webusb-dfu";

const FIRMWARE_PARTS = [
  "/experimental/v2-rc4/0.dat",
  "/experimental/v2-rc4/1.dat",
  "/experimental/v2-rc4/2.dat",
  "/experimental/v2-rc4/3.dat",
] as const;
const FIRMWARE_BYTES = 23_596;
const FIRMWARE_SHA256 = "843ff51b51facb8dfc1ae9a52623daae416c9caf7b13e72e5f2df5cea96dbf8e";

const KEY_PARTS = [
  "blPd7Ju+npnu/yWg",
  "3bxdI0hHO1pd0yCP",
  "qNxVCNPCjTs=",
] as const;
const IV_B64 = "f5+WnAQZqxwaMHdm";
const AAD = "tablet.ears.cat/experimental/earsfw-v2-rc4";

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function loadFirmware(): Promise<Uint8Array> {
  const encoded = (
    await Promise.all(
      FIRMWARE_PARTS.map(async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`firmware download failed (${response.status})`);
        return response.text();
      }),
    )
  ).join("");

  const encrypted = decodeBase64(encoded);
  const keyBytes = decodeBase64(KEY_PARTS.join(""));
  const iv = decodeBase64(IV_B64);
  const additionalData = new TextEncoder().encode(AAD);

  const key = await crypto.subtle.importKey(
    "raw",
    exactBuffer(keyBytes),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: exactBuffer(iv), additionalData: exactBuffer(additionalData) },
      key,
      exactBuffer(encrypted),
    ),
  );

  if (plain.length !== FIRMWARE_BYTES) {
    throw new Error(`firmware length ${plain.length} != ${FIRMWARE_BYTES}`);
  }
  const hash = await sha256Hex(plain);
  if (hash !== FIRMWARE_SHA256) {
    throw new Error(`firmware SHA-256 ${hash} != ${FIRMWARE_SHA256}`);
  }
  return plain;
}

function progressText(progress: FlashProgress): string {
  return `${progress.phase} ${progress.done}/${progress.total}`;
}

export default function Experimental() {
  const dfuRef = useRef<WebUsbDfuDevice | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("ready");

  useEffect(
    () => () => {
      void dfuRef.current?.close();
    },
    [],
  );

  const connect = async () => {
    setBusy(true);
    setStatus("connecting...");
    try {
      if (dfuRef.current) await dfuRef.current.close();
      const device = await WebUsbDfuDevice.request(s620);
      await device.open();
      dfuRef.current = device;
      setConnected(true);
      setStatus(`DFU connected: ${device.productName}`);
    } catch (error) {
      dfuRef.current = null;
      setConnected(false);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const flash = async () => {
    const device = dfuRef.current;
    if (!device) {
      setStatus("connect tablet in DFU mode first");
      return;
    }

    setBusy(true);
    try {
      setStatus("loading v2-rc4...");
      const image = await loadFirmware();
      const plan = planFlash(s620, [
        {
          address: s620.flash.appBase,
          data: image,
          label: "earsFW v2-rc4",
        },
      ]);

      await writeAndVerify(device, plan, s620.flash.pageSize, (progress) => {
        setStatus(progressText(progress));
      });

      await device.close();
      dfuRef.current = null;
      setConnected(false);
      setStatus(`v2-rc4 flashed + read-back verified (${FIRMWARE_SHA256.slice(0, 8)}...). replug tablet.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 20px", fontFamily: "monospace" }}>
      <button disabled={busy} onClick={connect}>
        {connected ? "DFU connected" : "connect tablet in DFU mode"}
      </button>{" "}
      <button disabled={busy || !connected} onClick={flash}>
        flash
      </button>
      <p>{status}</p>
    </main>
  );
}

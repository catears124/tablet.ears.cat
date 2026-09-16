"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildS62016KProtocolCandidate,
  exactS62016KTestUnit,
  type S62016KProtocolCandidate,
} from "@/lib/devices/s620-16k/experimental-candidate";
import { S620_16K_EXPERIMENTAL_ADAPTER } from "@/lib/devices/s620-16k/experimental-adapter";
import { S620_16K } from "@/lib/devices/s620-16k/fingerprint";
import { verifyBackupPair } from "@/lib/firmware/image";
import {
  activateS62016KProtocolHooks,
  restoreS62016KExperimentalPages,
  stageS62016KRuntimeWithoutErase,
  type ExperimentalWriteProgress,
} from "@/lib/transport/experimental-s620-16k-writer";
import { TabletLink } from "@/lib/transport/webhid";
import { WebUsbDfuDevice } from "@/lib/transport/webusb-dfu";

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

export default function ExperimentalS62016K() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>(["ready"]);
  const [progress, setProgress] = useState<string>("");
  const [backup, setBackup] = useState<Uint8Array | null>(null);
  const [candidate, setCandidate] = useState<S62016KProtocolCandidate | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  const [runtimeStaged, setRuntimeStaged] = useState(false);
  const [activationDone, setActivationDone] = useState(false);
  const [dfuConnected, setDfuConnected] = useState(false);
  const [normalConnected, setNormalConnected] = useState(false);
  const [penReports, setPenReports] = useState(0);
  const [normalSummary, setNormalSummary] = useState<string>("");

  const dfuRef = useRef<WebUsbDfuDevice | null>(null);
  const normalRef = useRef<TabletLink | null>(null);
  const normalUnsubscribeRef = useRef<(() => void) | null>(null);

  const say = (line: string) => setLog((current) => [line, ...current]);

  const reportProgress = (p: ExperimentalWriteProgress) => {
    setProgress(`${p.phase}: ${p.detail} (${p.done}/${p.total})`);
  };

  const guard = async (label: string, work: () => Promise<void>) => {
    setBusy(true);
    setProgress("");
    try {
      await work();
    } catch (error) {
      say(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => {
    normalUnsubscribeRef.current?.();
    void normalRef.current?.close();
    void dfuRef.current?.close();
  }, []);

  const closeDfu = async () => {
    const device = dfuRef.current;
    dfuRef.current = null;
    setDfuConnected(false);
    if (device) await device.close();
  };

  const prepareFromDevice = () => guard("prepare", async () => {
    await closeDfu();
    const device = await WebUsbDfuDevice.request(S620_16K_EXPERIMENTAL_ADAPTER);
    await device.open();
    dfuRef.current = device;
    setDfuConnected(true);
    say(`DFU connected: ${device.productName}`);

    const length = S620_16K.flash.end - S620_16K.flash.base;
    setProgress("read 1/2: full 128 KiB flash");
    const first = await device.read(S620_16K.flash.base, length);
    setProgress("read 2/2: full 128 KiB flash");
    const second = await device.read(S620_16K.flash.base, length);
    const pair = verifyBackupPair(S620_16K_EXPERIMENTAL_ADAPTER, { first, second });
    if (!pair.ok) throw new Error(pair.reason);

    const built = await buildS62016KProtocolCandidate(pair.image);
    if (!exactS62016KTestUnit(built.sourceFullSha256)) {
      throw new Error(
        `this first hardware test is pinned to backup ${S620_16K.firmware.fullBackupSha256}; ` +
          `device read ${built.sourceFullSha256}`,
      );
    }

    setBackup(pair.image.slice());
    setCandidate(built);
    setBackupSaved(false);
    setRuntimeStaged(built.runtimeWasAlreadyStaged);
    setActivationDone(false);
    say(`verified exact test unit: ${built.sourceFullSha256}`);
    say(`stock app verified: ${built.sourceAppSha256}`);
    say(
      `candidate locality verified: runtime ${hex(built.runtimeAddress)}..${hex(built.runtimeEnd)}; ` +
        `activation pages ${built.activationPages.map((page) => hex(page.address)).join(", ")}`,
    );
  });

  const saveRecoveryBackup = () => {
    if (!backup) return;
    const copy = backup.slice();
    const url = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gaomon-s620-16k_PRETEST_${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
    anchor.click();
    URL.revokeObjectURL(url);
    setBackupSaved(true);
    say("pre-test recovery backup download requested; write controls unlocked");
  };

  const loadRecoveryBackup = (file: File | null) => guard("load backup", async () => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const built = await buildS62016KProtocolCandidate(bytes);
    if (!exactS62016KTestUnit(built.sourceFullSha256)) {
      throw new Error(`backup is not the pinned pre-test image (${built.sourceFullSha256})`);
    }
    setBackup(bytes);
    setCandidate(built);
    setBackupSaved(true);
    say("exact pre-test recovery backup loaded and verified");
  });

  const stageRuntime = () => guard("stage runtime", async () => {
    if (!backupSaved || !candidate) throw new Error("verify and save the recovery backup first");
    const device = dfuRef.current;
    if (!device) throw new Error("connect DFU first");

    const result = await stageS62016KRuntimeWithoutErase(device, candidate, reportProgress);
    setRuntimeStaged(true);
    say(result === "written" ? "inert runtime staged and read-back verified" : "runtime was already staged and verified");
    say("DFU session closed. Re-enter DFU before activation so no erase follows a program operation.");
    await closeDfu();
  });

  const connectFreshDfu = () => guard("DFU", async () => {
    await closeDfu();
    const device = await WebUsbDfuDevice.request(S620_16K_EXPERIMENTAL_ADAPTER);
    await device.open();
    dfuRef.current = device;
    setDfuConnected(true);
    say(`fresh DFU session connected: ${device.productName}`);
  });

  const activateProtocol = () => guard("activate", async () => {
    if (!backupSaved || !runtimeStaged || !candidate) {
      throw new Error("prepare, save backup, and stage the inert runtime first");
    }
    const device = dfuRef.current;
    if (!device) throw new Error("re-enter DFU and connect a fresh session first");

    await activateS62016KProtocolHooks(device, candidate, reportProgress);
    setActivationDone(true);
    say("protocol activation pages read back byte-identical");
    say("unplug and reconnect normally, then run the read-only normal-mode test below");
    await closeDfu();
  });

  const testNormalMode = () => guard("normal test", async () => {
    normalUnsubscribeRef.current?.();
    normalUnsubscribeRef.current = null;
    if (normalRef.current) await normalRef.current.close();

    const link = await TabletLink.request(S620_16K_EXPERIMENTAL_ADAPTER);
    normalRef.current = link;
    if (!(await link.hasRuntimeFraming())) {
      throw new Error("HID descriptor did not expose the expected 32-byte feature report");
    }

    const info = await link.getInfo();
    if (info.modelId !== S620_16K.firmware.protocolModelId) {
      throw new Error(`GET_INFO model id is 0x${info.modelId.toString(16)}, expected 0x${S620_16K.firmware.protocolModelId.toString(16)}`);
    }
    if (info.stockFirmwareId !== S620_16K.firmware.protocolStockFirmwareId) {
      throw new Error(
        `GET_INFO firmware id is 0x${info.stockFirmwareId.toString(16)}, ` +
          `expected 0x${S620_16K.firmware.protocolStockFirmwareId.toString(16)}`,
      );
    }
    if (info.capabilities.length !== 1 || info.capabilities[0] !== "LiveConfig") {
      throw new Error(`GET_INFO advertised unexpected capabilities: ${info.capabilities.join(", ") || "none"}`);
    }

    const config = await link.getConfig();
    setNormalSummary(
      `protocol ${info.protocolVersion}, runtime ${info.firmwareVersion}, model 0x${info.modelId.toString(16)}, ` +
        `firmware 0x${info.stockFirmwareId.toString(16)}, capabilities=${info.capabilities.join("+")}, ` +
        `config target=${config.targetRateHz}`,
    );
    setPenReports(0);
    normalUnsubscribeRef.current = link.onPenReport(() => setPenReports((count) => count + 1));
    setNormalConnected(true);
    say("GET_INFO + GET_CONFIG passed; pen listener armed (move/hover the pen to prove report 0x08 stayed alive)");
  });

  const restore = () => guard("restore", async () => {
    if (!backup || !candidate) throw new Error("load the exact pre-test recovery backup first");
    const device = dfuRef.current;
    if (!device) throw new Error("enter DFU and connect a fresh session first");

    await restoreS62016KExperimentalPages(device, backup, candidate, reportProgress);
    say("all experimental pages restored to the exact pre-test backup and verified");
    setRuntimeStaged(false);
    setActivationDone(false);
    await closeDfu();
  });

  return (
    <main style={{ maxWidth: 860, margin: "40px auto", padding: "0 20px", fontFamily: "monospace" }}>
      <section style={{ marginTop: 24 }}>
        <h2>1.</h2>
        <button disabled={busy} onClick={prepareFromDevice}>connect DFU + read twice + verify</button>{" "}
        <button disabled={busy || !backup} onClick={saveRecoveryBackup}>download pre-test backup</button>
        <div style={{ marginTop: 10 }}>
          <input
            type="file"
            accept=".bin,application/octet-stream"
            disabled={busy}
            onChange={(event) => void loadRecoveryBackup(event.target.files?.[0] ?? null)}
          />
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>2.</h2>
        <button disabled={busy || !candidate || !backupSaved || runtimeStaged} onClick={stageRuntime}>
          stage + read-back verify runtime
        </button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>3.</h2>
        <button disabled={busy} onClick={connectFreshDfu}>{dfuConnected ? "reconnect fresh DFU" : "connect fresh DFU"}</button>{" "}
        <button disabled={busy || !dfuConnected || !runtimeStaged || !backupSaved || activationDone} onClick={activateProtocol}>
          activate hooks
        </button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>4.</h2>
        <button disabled={busy} onClick={testNormalMode}>connect normal tablet + GET_INFO + GET_CONFIG</button>
        {normalConnected && (
          <div style={{ marginTop: 10 }}>
            <div>{normalSummary}</div>
            <div>pen report 0x08 events observed: {penReports}</div>
          </div>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>5.</h2>
        <button disabled={busy} onClick={connectFreshDfu}>connect DFU for restore</button>{" "}
        <button disabled={busy || !dfuConnected || !backup || !candidate} onClick={restore}>restore + read-back verify</button>
      </section>

      {progress && <p style={{ marginTop: 20 }}><strong>{progress}</strong></p>}

      <section style={{ marginTop: 24 }}>
        <div>
          {log.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
        </div>
      </section>
    </main>
  );
}

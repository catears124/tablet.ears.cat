"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ADAPTERS } from "@/lib/devices/registry";
import { VENDOR_FIRMWARE, decodeVendorImage } from "@/lib/devices/s620/codec";
import type { BuildResult, DeviceAdapter } from "@/lib/devices/types";
import type { TabletConfig } from "@/lib/firmware/config";
import type { DeviceInfo, Telemetry } from "@/lib/firmware/protocol";
import { planFlash, type WriteRegion } from "@/lib/firmware/flashplan";
import { extractStockApp, inspectInstalledApplication, sha256Hex, verifyBackupPair, verifyStockApp } from "@/lib/firmware/image";
import { writeAndVerify } from "@/lib/transport/flash-writer";
import { RateMeter, type RateSnapshot } from "@/lib/transport/rate-meter";
import { TabletLink } from "@/lib/transport/webhid";
import { WebUsbDfuDevice, type DfuProgress } from "@/lib/transport/webusb-dfu";
import { useDeviceApis } from "@/lib/use-device-apis";
import { hex } from "@/lib/format";

type View = "install" | "cfg";
type InstallTarget = "tablet" | "factory";
type RatePoint = { t: number; hz: number };
type OperationProgress = {
  stage: number;
  total: number;
  label: string;
  percent: number;
  detail?: string;
};

function buildInstallRegions(adapter: DeviceAdapter, result: BuildResult): WriteRegion[] {
  const regions: WriteRegion[] = [
    {
      address: adapter.flash.appBase,
      data: result.app.slice(0, adapter.flash.appLength),
      label: "tablet.ears.cat application hooks",
    },
  ];

  for (const range of result.appended) {
    const start = range.start - adapter.flash.appBase;
    const end = range.end - adapter.flash.appBase;
    if (start < 0 || end > result.app.length || end <= start) {
      throw new Error(`builder returned invalid appended range ${hex(range.start)}..${hex(range.end)}`);
    }
    regions.push({ address: range.start, data: result.app.slice(start, end), label: range.label });
  }

  return regions;
}

function bytesMatchAt(fullFlash: Uint8Array, flashBase: number, address: number, expected: Uint8Array): boolean {
  const offset = address - flashBase;
  if (offset < 0 || offset + expected.length > fullFlash.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (fullFlash[offset + index] !== expected[index]) return false;
  }
  return true;
}

function backupHasRuntimeHooks(adapter: DeviceAdapter, backup: Uint8Array, result: BuildResult): boolean {
  if (result.appended.length === 0 || result.sites.length === 0) return false;
  return result.sites.every((site) => bytesMatchAt(backup, adapter.flash.flashBase, site.address, site.after));
}

function backupHasCurrentRuntimeExtension(adapter: DeviceAdapter, backup: Uint8Array, result: BuildResult): boolean {
  if (result.appended.length === 0) return false;
  return result.appended.every((range) => {
    const start = range.start - adapter.flash.appBase;
    const end = range.end - adapter.flash.appBase;
    if (start < 0 || end > result.app.length || end <= start) return false;
    return bytesMatchAt(backup, adapter.flash.flashBase, range.start, result.app.slice(start, end));
  });
}

function polyline(points: Array<{ x: number; y: number }>): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} mb`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kb`;
  return `${bytes} b`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return "<1s left";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  return `${Math.ceil(seconds / 60)}m left`;
}

async function readDownload(
  response: Response,
  expectedBytes: number,
  onProgress: (received: number, total: number, bytesPerSecond: number, etaSeconds: number) => void,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(bytes.length, expectedBytes, 0, 0);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const startedAt = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    if (received > expectedBytes) {
      await reader.cancel();
      throw new Error(`download exceeded expected size (${received} > ${expectedBytes} bytes)`);
    }
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
    const bytesPerSecond = received / elapsedSeconds;
    const etaSeconds = bytesPerSecond > 0 ? (expectedBytes - received) / bytesPerSecond : Number.POSITIVE_INFINITY;
    onProgress(received, expectedBytes, bytesPerSecond, etaSeconds);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function ProgressBar({ progress }: { progress: OperationProgress }) {
  return (
    <div className="operation-progress" aria-live="polite">
      <div className="progress-head">
        <span>({progress.stage}/{progress.total}) {progress.label}</span>
        <span>{Math.round(progress.percent)}%</span>
      </div>
      <progress max={100} value={progress.percent} />
      {progress.detail && <small>{progress.detail}</small>}
    </div>
  );
}

function RateGraph({ history, target, minHz, maxHz }: { history: RatePoint[]; target: number; minHz: number; maxHz: number }) {
  const width = 800;
  const height = 160;
  const now = history.at(-1)?.t ?? 0;
  const start = now - 10_000;
  const visible = history.filter((point) => point.t >= start);
  const values = [target, ...visible.map((point) => point.hz)];
  let low = minHz;
  let high = maxHz;

  if (visible.length > 0) {
    low = Math.min(...values);
    high = Math.max(...values);
    const pad = Math.max(4, (high - low) * 0.15);
    low -= pad;
    high += pad;
  }

  const span = Math.max(1, high - low);
  const line = visible.map((point) => ({
    x: ((point.t - start) / 10_000) * width,
    y: height - ((point.hz - low) / span) * height,
  }));
  const targetY = height - ((target - low) / span) * height;

  return (
    <div className="graph-block">
      <svg className="graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="host observed hid report rate over the last 10 seconds">
        <line x1="0" y1={targetY} x2={width} y2={targetY} className="graph-guide" />
        {line.length > 1 && <polyline points={polyline(line)} className="graph-line" />}
      </svg>
    </div>
  );
}

export function FlashTool() {
  const [view, setView] = useState<View>("install");
  const [installTarget, setInstallTarget] = useState<InstallTarget>("tablet");
  const [adapter, setAdapter] = useState<DeviceAdapter | null>(null);
  const apis = useDeviceApis();

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [log, setLog] = useState<string[]>(["logging ready"]);
  const [dfuConnected, setDfuConnected] = useState(false);
  const [verifiedBackup, setVerifiedBackup] = useState<Uint8Array | null>(null);
  const [stockApp, setStockApp] = useState<Uint8Array | null>(null);
  const [normalInfo, setNormalInfo] = useState<DeviceInfo | null>(null);
  const [liveConfig, setLiveConfig] = useState<TabletConfig | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [hostRate, setHostRate] = useState<RateSnapshot | null>(null);
  const [rateHistory, setRateHistory] = useState<RatePoint[]>([]);

  const dfuRef = useRef<WebUsbDfuDevice | null>(null);
  const normalRef = useRef<TabletLink | null>(null);
  const normalUnsubscribeRef = useRef<(() => void) | null>(null);
  const configRef = useRef<TabletConfig | null>(null);
  const rateTimerRef = useRef<number | null>(null);

  const stockFile = useMemo(
    () => adapter ? VENDOR_FIRMWARE.find((entry) => entry.decodedSha256 === adapter.firmware.stockAppSha256) : undefined,
    [adapter],
  );

  const currentAdapter = () => {
    if (!adapter) throw new Error("select a tablet model first");
    return adapter;
  };

  const say = useCallback((line: string) => setLog((current) => [line, ...current]), []);
  const stage = useCallback((stageNumber: number, label: string, percent: number, detail?: string) => {
    setProgress({ stage: stageNumber, total: 4, label, percent: Math.max(0, Math.min(100, percent)), detail });
  }, []);

  useEffect(() => () => {
    normalUnsubscribeRef.current?.();
    if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
    void normalRef.current?.close();
    void dfuRef.current?.close();
  }, []);

  const guard = useCallback(async (label: string, work: () => Promise<void>) => {
    setBusy(true);
    setProgress(null);
    try {
      await work();
    } catch (error) {
      say(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [say]);

  const setLocalConfig = useCallback((config: TabletConfig | null) => {
    configRef.current = config;
    setLiveConfig(config);
  }, []);

  const resetConnections = useCallback(() => {
    normalUnsubscribeRef.current?.();
    normalUnsubscribeRef.current = null;
    if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
    rateTimerRef.current = null;
    void normalRef.current?.close();
    void dfuRef.current?.close();
    normalRef.current = null;
    dfuRef.current = null;
    setDfuConnected(false);
    setVerifiedBackup(null);
    setStockApp(null);
    setProgress(null);
    setNormalInfo(null);
    setLocalConfig(null);
    setTelemetry(null);
    setHostRate(null);
    setRateHistory([]);
  }, [setLocalConfig]);

  const connectDfu = () => guard("dfu", async () => {
    const current = currentAdapter();
    if (dfuRef.current) await dfuRef.current.close();
    const device = await WebUsbDfuDevice.request(current);
    await device.open();
    dfuRef.current = device;
    setDfuConnected(true);
    say("dfu connected");
  });

  const readVerifiedBackup = async (): Promise<Uint8Array> => {
    const current = currentAdapter();
    if (verifiedBackup) {
      stage(1, "device verified", 100);
      return verifiedBackup;
    }

    const device = dfuRef.current;
    if (!device) throw new Error("connect dfu first");
    const flashLength = current.flash.flashEnd - current.flash.flashBase;

    stage(1, "read 1", 0);
    const first = await device.read(current.flash.flashBase, flashLength, (p: DfuProgress) =>
      stage(1, "read 1", (p.done / p.total) * 45),
    );

    stage(1, "read 2", 50);
    const second = await device.read(current.flash.flashBase, flashLength, (p: DfuProgress) =>
      stage(1, "read 2", 50 + (p.done / p.total) * 45),
    );

    stage(1, "verify device", 97);
    const pair = verifyBackupPair(current, { first, second });
    if (!pair.ok) throw new Error(pair.reason);

    setVerifiedBackup(pair.image.slice());
    say(`backup verified ${await sha256Hex(pair.image)}`);
    stage(1, "device verified", 100);
    return pair.image;
  };

  const downloadBackup = () => {
    if (!verifiedBackup || !adapter) return;
    const copy = new Uint8Array(verifiedBackup);
    const url = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${adapter.id}_backup_${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const getStockApp = async (sourceBackup?: Uint8Array): Promise<Uint8Array> => {
    const current = currentAdapter();
    if (stockApp) {
      stage(2, "factory image verified", 100);
      return stockApp;
    }

    if (!stockFile) {
      if (!sourceBackup) throw new Error("read and verify this tablet before recovering its factory image");
      stage(2, "recover factory image", 50);

      let recovered = extractStockApp(current, sourceBackup);
      let verdict = await verifyStockApp(current, recovered);
      if (!verdict.ok) {
        const normalized = recovered.slice();
        for (const site of current.patches.describe()) {
          if (site.before.length !== site.after.length) continue;
          const offset = site.address - current.flash.appBase;
          if (offset < 0 || offset + site.after.length > normalized.length) continue;
          if (bytesMatchAt(normalized, current.flash.appBase, site.address, site.after)) {
            normalized.set(site.before, offset);
          }
        }
        recovered = normalized;
        verdict = await verifyStockApp(current, recovered);
      }
      if (!verdict.ok) {
        throw new Error(`could not reconstruct the pinned factory app from this verified backup: ${verdict.reason}`);
      }

      setStockApp(recovered);
      say(`factory firmware recovered from verified device backup: ${current.firmware.buildId}`);
      stage(2, "factory image verified", 100);
      return recovered;
    }

    stage(2, "download factory image", 0, `0 / ${formatBytes(stockFile.bytes)}`);
    const response = await fetch(stockFile.downloadPath, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.text()) || `download failed with http ${response.status}`);

    const encoded = await readDownload(response, stockFile.bytes, (received, total, speed, eta) => {
      stage(
        2,
        "download factory image",
        (received / total) * 100,
        `${formatBytes(received)} / ${formatBytes(total)} · ${formatSpeed(speed)} · ${formatEta(eta)}`,
      );
    });

    if (encoded.length !== stockFile.bytes) throw new Error(`downloaded ${encoded.length} bytes, expected ${stockFile.bytes}`);

    stage(2, "verify factory image", 100);
    const vendorHash = await sha256Hex(encoded);
    if (vendorHash !== stockFile.vendorSha256) throw new Error(`factory firmware sha-256 mismatch: ${vendorHash}`);

    const decoded = decodeVendorImage(encoded);
    const verdict = await verifyStockApp(current, decoded);
    if (!verdict.ok || verdict.sha256 !== stockFile.decodedSha256) {
      throw new Error(verdict.ok ? `decoded sha-256 mismatch: ${verdict.sha256}` : verdict.reason);
    }

    setStockApp(decoded);
    say(`factory firmware verified: ${stockFile.build}`);
    stage(2, "factory image verified", 100);
    return decoded;
  };

  const flashPlan = async (regions: WriteRegion[]): Promise<boolean> => {
    const current = currentAdapter();
    const device = dfuRef.current;
    if (!device) throw new Error("connect dfu first");

    const plan = planFlash(current, regions);

    stage(3, "erase", 0);
    const outcome = await writeAndVerify(device, plan, current.flash.pageSize, (p) => {
      const ratio = p.total === 0 ? 0 : p.done / p.total;
      if (p.phase === "erase") stage(3, "erase + blank check", ratio * 100);
      else if (p.phase === "write") stage(4, "write", ratio * 65);
      else stage(4, "readback verify", 65 + ratio * 35);
    });

    stage(4, "verified", 100);
    say(`verified ${outcome.bytes} bytes across ${outcome.pages} pages`);
    return true;
  };

  const installTabletFirmware = () => guard("install", async () => {
    const current = currentAdapter();
    const backup = await readVerifiedBackup();
    const installed = await inspectInstalledApplication(current, backup);
    if (installed.status === "unsupported") throw new Error(installed.reason);

    const stock = await getStockApp(backup);
    const stockVerdict = await verifyStockApp(current, stock);
    if (!stockVerdict.ok) throw new Error(stockVerdict.reason);

    if (installed.status === "legacy") {
      say(`older firmware detected: ${installed.buildId}; updating to ${current.firmware.buildId} first`);
      stage(2, "factory update ready", 100);
      await flashPlan([{ address: current.flash.appBase, data: stock, label: "factory application" }]);

      const device = dfuRef.current;
      if (!device) throw new Error("dfu disconnected during factory update");
      stage(2, "verify factory update", 0);
      const updatedApp = await device.read(current.flash.appBase, current.flash.appLength, (p: DfuProgress) =>
        stage(2, "verify factory update", (p.done / p.total) * 100),
      );
      const updatedVerdict = await verifyStockApp(current, updatedApp);
      if (!updatedVerdict.ok) throw new Error(`factory update verification failed: ${updatedVerdict.reason}`);
      say(`factory firmware updated and verified: ${current.firmware.buildId}`);
    }

    stage(2, "build tablet.ears.cat image", 100);
    const result = current.patches.build(stock);
    const regions = buildInstallRegions(current, result);
    const hasRuntimeHooks = installed.status === "patched" && backupHasRuntimeHooks(current, backup, result);
    const hasRuntimeExtension = installed.status === "patched" && backupHasCurrentRuntimeExtension(current, backup, result);

    if (hasRuntimeHooks) say("existing tablet.ears.cat runtime hooks recognized; reinstall allowed");
    else if (hasRuntimeExtension) say("existing tablet.ears.cat extension recognized; reinstall allowed");

    stage(2, "image ready", 100);
    const flashed = await flashPlan(regions);
    if (flashed) {
      say('click "cfg" in the top right of the page to configure settings');
      say("done. unplug and replug tablet to use.");
    }
  });

  const restoreFactory = () => guard("factory", async () => {
    const current = currentAdapter();
    const backup = await readVerifiedBackup();
    const installed = await inspectInstalledApplication(current, backup);
    if (installed.status === "unsupported") throw new Error(installed.reason);
    if (installed.status === "legacy") say(`older firmware detected: ${installed.buildId}; updating to ${current.firmware.buildId}`);

    const stock = await getStockApp(backup);
    const built = current.patches.build(stock);
    const regions: WriteRegion[] = [{ address: current.flash.appBase, data: stock, label: "factory application" }];
    for (const range of built.appended) {
      regions.push({
        address: range.start,
        data: new Uint8Array(range.end - range.start).fill(0xff),
        label: `clear ${range.label}`,
      });
    }
    stage(2, "factory image ready", 100);
    const flashed = await flashPlan(regions);
    if (flashed) say("done. unplug and replug tablet to use.");
  });

  const connectNormal = () => guard("cfg", async () => {
    const current = currentAdapter();
    normalUnsubscribeRef.current?.();
    if (normalRef.current) await normalRef.current.close();

    const link = await TabletLink.request(current);
    normalRef.current = link;
    if (!(await link.hasRuntimeFraming())) {
      await link.close();
      normalRef.current = null;
      throw new Error("tablet.ears.cat is not installed on the selected tablet");
    }

    const info = await link.getInfo();
    if (info.modelId !== current.firmware.modelId || info.stockFirmwareId !== current.firmware.stockFirmwareId) {
      throw new Error("tablet identity mismatch");
    }

    setNormalInfo(info);
    setLocalConfig(await link.getConfig());
    setTelemetry(await link.getTelemetry());

    const meter = new RateMeter(1000);
    let lastPublish = 0;
    normalUnsubscribeRef.current = link.onPenReport((sample) => {
      meter.push(sample.timestampMs, sample.data);
      if (sample.timestampMs - lastPublish < 200) return;
      lastPublish = sample.timestampMs;
      const snapshot = meter.snapshot(sample.timestampMs);
      setHostRate(snapshot);
      if (snapshot.hz != null) {
        setRateHistory((currentHistory) => [
          ...currentHistory.filter((point) => point.t >= sample.timestampMs - 10_000),
          { t: sample.timestampMs, hz: snapshot.hz! },
        ]);
      }
    });
  });

  const commitLiveConfig = useCallback(async (logSuccess = false) => {
    const link = normalRef.current;
    const config = configRef.current;
    if (!link || !config) return;
    try {
      const accepted = await link.setConfig(config);
      setLocalConfig(accepted);
      setTelemetry(await link.getTelemetry());
      if (logSuccess) say("settings applied");
    } catch (error) {
      say(`cfg: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [say, setLocalConfig]);

  const scheduleRate = (targetRateHz: number) => {
    const current = configRef.current;
    if (!current || !normalInfo) return;
    const clamped = Math.max(normalInfo.minHz, Math.min(normalInfo.maxHz, Math.round(targetRateHz)));
    setLocalConfig({ ...current, targetRateHz: clamped });
    if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
    rateTimerRef.current = window.setTimeout(() => {
      rateTimerRef.current = null;
      void commitLiveConfig();
    }, 120);
  };

  const saveConfig = () => guard("cfg", async () => {
    const link = normalRef.current;
    if (!link) throw new Error("connect first");
    await link.saveConfig();
    setTelemetry(await link.getTelemetry());
    say("saved to tablet");
  });

  const resetConfig = () => guard("cfg", async () => {
    const link = normalRef.current;
    if (!link) throw new Error("connect first");
    setLocalConfig(await link.factoryDefaults());
    setTelemetry(await link.getTelemetry());
  });

  const selectedInstall = installTarget === "tablet" ? installTabletFirmware : restoreFactory;

  return (
    <div id="tool">
      <header className="topbar">
        <div className="brand">
          <h1>tablet.ears.cat</h1>
          <small>i am not responsible for any damages</small>
        </div>
        <nav className="view-nav" aria-label="view">
          <button className={`nav-link ${view === "install" ? "active" : ""}`} onClick={() => setView("install")}>install</button>
          <span>/</span>
          <button className={`nav-link ${view === "cfg" ? "active" : ""}`} onClick={() => setView("cfg")}>cfg</button>
        </nav>
      </header>

      <div className="device-row">
        <div className="device-select">
          <select
            value={adapter?.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              const next = ADAPTERS.find((candidate) => candidate.id === event.target.value) ?? null;
              resetConnections();
              setAdapter(next);
            }}
          >
            <option value="" disabled>Tablet model</option>
            {ADAPTERS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName} · {candidate.firmware.buildId}
              </option>
            ))}
          </select>
        </div>
        {view === "install" ? (
          <button onClick={connectDfu} disabled={busy || !adapter || (apis.ready && !apis.usb)}>connect dfu</button>
        ) : (
          <button onClick={connectNormal} disabled={busy || !adapter || (apis.ready && !apis.hid)}>connect tablet</button>
        )}
      </div>

      {view === "install" && (
        <div className="install-view">
          <p className="instructions">unplug your tablet, hold down the left and right-most buttons, and replug it in, if no light comes on, press &quot;connect dfu&quot;</p>

          <div className="install-options" role="radiogroup" aria-label="firmware to install">
            <button
              type="button"
              className={`install-option ${installTarget === "tablet" ? "selected" : ""}`}
              aria-pressed={installTarget === "tablet"}
              onClick={() => setInstallTarget("tablet")}
              disabled={busy}
            >
              <strong>tablet.ears.cat</strong>
              <small>install the custom firmware patch</small>
            </button>
            <button
              type="button"
              className={`install-option ${installTarget === "factory" ? "selected" : ""}`}
              aria-pressed={installTarget === "factory"}
              onClick={() => setInstallTarget("factory")}
              disabled={busy}
            >
              <strong>factory</strong>
              <small>restore the original gaomon firmware</small>
            </button>
          </div>

          <button className="install-button" onClick={selectedInstall} disabled={busy || !dfuConnected || !adapter}>install</button>

          {progress && <ProgressBar progress={progress} />}
          {verifiedBackup && (
            <div className="backup-link">backup verified · <button className="text-button" onClick={downloadBackup} disabled={busy}>download backup</button></div>
          )}
          {apis.ready && !apis.usb && <p className="error-line">webusb is unavailable in this browser</p>}
        </div>
      )}

      {view === "cfg" && (
        <div className="cfg-view">
          <p className="instructions">you may need to unplug and replug your tablet without pressing any buttons</p>
          {apis.ready && !apis.hid && <p className="error-line">webhid is unavailable in this browser</p>}

          {normalInfo && liveConfig && (
            <>
              <section className="rate-section">
                <div className="rate-heading">
                  <div>
                    <div className="label">polling</div>
                    <div className="rate-number">{liveConfig.targetRateHz}<span> hz</span></div>
                  </div>
                  <div className="rate-actual">
                    actual<br />
                    <strong>{hostRate?.hz == null ? "—" : hostRate.hz.toFixed(1)}</strong> hz
                    {hostRate?.duplicateRatio == null ? null : <><br /><span>{(hostRate.duplicateRatio * 100).toFixed(1)}% dupes</span></>}
                  </div>
                </div>

                <input
                  className="poll-slider"
                  aria-label="polling rate"
                  type="range"
                  min={normalInfo.minHz}
                  max={normalInfo.maxHz}
                  step={1}
                  value={liveConfig.targetRateHz}
                  onChange={(event) => scheduleRate(Number(event.target.value))}
                />
                <div className="range-labels"><span>{normalInfo.minHz}</span><span>{normalInfo.maxHz}</span></div>
                <RateGraph history={rateHistory} target={liveConfig.targetRateHz} minHz={normalInfo.minHz} maxHz={normalInfo.maxHz} />
              </section>

              <section className="smoothing-section">
                <h2>smoothing</h2>
                <label className="ema-control">
                  <span>ema ({liveConfig.emaWeight})</span>
                  <span className="ema-spacer" />
                  <span className="muted">smoothest</span>
                  <input
                    type="range"
                    min={1}
                    max={255}
                    value={liveConfig.emaWeight}
                    onChange={(event) => setLocalConfig({ ...liveConfig, emaWeight: Number(event.target.value) })}
                  />
                  <span className="muted">{adapter?.id === "gaomon-s620-16k" ? "off" : "fastest/unstable"}</span>
                </label>
                <label className="control-row compact">
                  <span>average window</span>
                  <select
                    value={liveConfig.averageWindow}
                    onChange={(event) => setLocalConfig({ ...liveConfig, averageWindow: Number(event.target.value) })}
                  >
                    {[1, 2, 3, 4].map((window) => <option key={window} value={window}>{window}</option>)}
                  </select>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={liveConfig.fastBarrelButtons}
                    onChange={(event) => setLocalConfig({ ...liveConfig, fastBarrelButtons: event.target.checked })}
                  />
                  fast barrel buttons
                </label>
                <div className="actions config-actions">
                  <button onClick={() => void commitLiveConfig(true)} disabled={busy}>apply</button>
                  {normalInfo.capabilities.includes("Persistence") && (
                    <button onClick={saveConfig} disabled={busy}>save</button>
                  )}
                  <button onClick={resetConfig} disabled={busy}>reset</button>
                  {telemetry?.unsaved && <span className="muted unsaved-status">unsaved</span>}
                </div>
              </section>
            </>
          )}
        </div>
      )}

      <div className="log-lines" aria-live="polite">
        {log.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
      </div>
    </div>
  );
}
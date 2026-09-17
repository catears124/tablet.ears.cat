# Gaomon S620 (16K) port

This directory contains the 16K-pressure S620 revision port.

## Pinned device

- normal USB: `256c:006f`
- DFU USB: `28e9:0189`
- OTD device string family: `GM001_T263_\\d{6}`
- tested stock build: `GM001_T263_260527`
- app: `0x08004000..0x0800cd24` (`0x8d24` bytes)
- stock app SHA-256: `ec124d9675d3f35bb49f81b7e5f82f1dcada43f16d13d61fd571e3c87974212d`
- first test-unit full backup SHA-256: `75849255b246dcffc4afa24a80ae33d0297e0caca81fd0c98fd9f0ea161db498`

The original S620 runtime base (`0x0800cc00`) overlaps `0x124` bytes of this stock application, so the 16K runtime is relocated to `0x0800d000`.

## Verified old -> 16K mappings

The runtime port rebases verified counterparts for:

- vendor feature-report helper/continuation/dispatch path
- smoothing helper: `0x08004a90 -> 0x08004ac4`
- averaging helper: `0x0800a04c -> 0x0800a23c`
- delay helper: `0x08006b2e -> 0x08006b96`
- barrel-button helper: `0x08006cb4 -> 0x08006d1c`

The protocol hooks are:

- `0x0800b824` -> runtime `+0x004`
- `0x0800b884` -> runtime `+0x032`
- `0x0800b994` -> runtime `+0x064`
- `0x0800c7e5: 9507 -> 9520` (feature report 0x16 becomes 32 bytes)

Every hook carries an exact stock preimage guard.

## /experimental protocol bring-up

The isolated `/experimental` path remains available for the original protocol-only bring-up. It is pinned to the exact first test-unit full backup and deliberately leaves timing/filtering hooks untouched.

The test sequence was:

1. Read the complete 128 KiB flash twice and require byte identity.
2. Require the exact pinned stock application and first test-unit full-backup hash.
3. Build the relocated runtime and prove candidate locality.
4. Require a recovery-backup download before writes.
5. Stage the runtime at `0x0800d000` without erase and read it back.
6. Re-enter DFU in a fresh session.
7. Re-read the staged runtime and complete stock activation pages.
8. Erase/blank-check only the two protocol activation pages.
9. Program descriptor page first, executable hook page last, then read both back.
10. Reboot normally and verify runtime framing, `GET_INFO`, `GET_CONFIG`, and unchanged pen report `0x08` traffic.

## Hardware validation

The protocol-only candidate was validated on a second independently owned S620 16K with a byte-identical full 128 KiB stock image. The second unit:

- staged and read back the relocated runtime successfully;
- activated and read back both protocol pages byte-identically;
- booted normally;
- returned valid `GET_INFO` and `GET_CONFIG` responses (`runtime 1.1`, model `0x1620`, firmware `0x260527`, `LiveConfig`);
- preserved normal pen report `0x08` traffic (thousands of reports observed);
- restored back to the exact pre-test stock image successfully.

## Normal installer: `s620-16k (experimental)`

The normal site exposes the revision as `s620-16k (experimental)`.

The experimental performance build keeps the validated protocol runtime, appends small 16K-specific wrappers, and adds exact-preimage hooks for:

- both coordinate moving-average calls;
- both EMA calls;
- all six direct microsecond-delay calls in the two mapped acquisition/setup routines;
- both mapped barrel-button rescan calls.

After live config initializes, the default profile is:

- target: `550 Hz`;
- EMA: off (`255`, intercepted as an exact identity path);
- moving-average window: `1`.

Before live config initializes, the wrappers deliberately preserve stock behavior: EMA uses the stock weight, moving average uses the stock four-sample window, and timing passes the original delay through unchanged. This prevents an uninitialized RAM config from silently selecting the aggressive profile during boot.

The timing wrapper maps targets `294..550` onto the stock delay budget. At 294 the mapping is exact identity. At 550 the delay fraction is `6/227`, matching the minimum settle fraction used by the original S620 experimental timing work. **550 is an experimental target, not a measured 16K ceiling**; the site's `actual` value remains the host-observed HID report rate.

The performance runtime is `0x5e6` bytes and occupies `0x0800d000..0x0800d5e6`, entirely before persistence at `0x0800f800`. The only application pages changed by the full performance patch are:

- `0x08004c00`
- `0x08007400`
- `0x08008000`
- `0x0800b800`
- `0x0800c400`

The runtime pages are `0x0800d000` and `0x0800d400`. The resident bootloader and all bytes from persistence (`0x0800f800`) through the protected flash tail remain outside every normal-installer write range.

Persistence is intentionally disabled for this experimental adapter. The runtime reports persistence `0`, `SAVE_CONFIG` is disabled in command dispatch, and the normal UI does not expose a save button. Live `SET_CONFIG` remains available.

Because no distributable factory image is pinned for this revision, the normal installer derives the exact factory application from the twice-read device backup. A stock app is accepted directly; a recognized tablet.ears.cat image is normalized by reverting only exact known hook postimages and must then hash to the pinned stock SHA-256. Factory restore also clears the injected runtime pages while preserving the per-device persistence/tail region.

## Next hardware pass

Install the normal experimental build from the dropdown, verify normal boot and pen traffic, connect through `cfg`, confirm `GET_INFO` reports `294..550`, measure the host-observed rate/noise at 550 with EMA off and average window 1, exercise buttons/pressure/proximity, then perform the normal factory restore and read-back check.

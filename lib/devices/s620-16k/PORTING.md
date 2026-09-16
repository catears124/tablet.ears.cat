# Gaomon S620 (16K) port

This directory is the isolated bring-up for the 16K-pressure S620 revision.

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

The protocol/runtime scaffold currently rebases verified counterparts for:

- vendor feature-report helper/continuation/dispatch path
- smoothing helper: `0x08004a90 -> 0x08004ac4`
- averaging helper: `0x0800a04c -> 0x0800a23c`
- delay helper: `0x08006b2e -> 0x08006b96`
- barrel-button helper: `0x08006cb4 -> 0x08006d1c`

The first hardware candidate enables only the protocol path:

- `0x0800b824` -> runtime `+0x004`
- `0x0800b884` -> runtime `+0x032`
- `0x0800b994` -> runtime `+0x064`
- `0x0800c7e5: 9507 -> 9520` (feature report 0x16 becomes 32 bytes)

Every hook carries an exact stock preimage guard. The three 8-byte hook preimages and the descriptor preimage are unique in the pinned 128 KiB dump.

## /experimental bring-up

The main installer still does not register this adapter. `/experimental` is intentionally separate and the first pass is pinned to the exact pre-test unit backup.

The test is staged so the highest-risk operation is last:

1. Read the complete 128 KiB flash twice and require byte identity.
2. Require the exact pinned stock application and exact first test-unit full backup hash.
3. Build the relocated runtime and prove candidate changes are limited to the runtime pages plus stock pages `0x0800b800` and `0x0800c400`.
4. Force a recovery-backup download before write controls unlock.
5. Stage the runtime at `0x0800d000` without erasing anything. It is inert because no stock branch points to it yet. Read it back byte-for-byte.
6. Close the DFU session. The user physically re-enters DFU before activation, preserving the existing no-erase-after-program invariant.
7. Re-read the staged runtime and both complete stock activation pages. Refuse unless all match the verified candidate inputs.
8. Erase and blank-check only `0x0800c400` and `0x0800b800` before any write.
9. Program the non-executable HID-descriptor page first and the executable feature-report hook page last. Read both back byte-for-byte.
10. Reboot normally and perform only read-only WebHID checks: 32-byte runtime framing, `GET_INFO`, `GET_CONFIG`, and observation of unchanged pen report `0x08` traffic.

No timing, smoothing, averaging, barrel-button or persistence write hook is active in this test.

## Recovery

`/experimental` accepts only the exact pinned pre-test full-flash backup for recovery. On a fresh DFU session it erases every page the experiment can touch, restores the original stock pages from that backup, leaves the originally-erased runtime pages erased, and verifies every page afterward. The resident bootloader is outside every experimental erase/write range.

A live flash can never be mathematically zero-risk (for example, physical power loss during an erase/program transaction), but this sequence minimizes the write surface and keeps the DFU bootloader untouched so the failure mode remains a DFU restore rather than a bootloader overwrite.

## Still blocked before production support

- prove protocol-only candidate boots on hardware
- prove normal pen report `0x08` remains live while the protocol hooks are active
- port 16K smoothing semantics instead of assuming the old S620 call contract
- reverse/measure the 16K timing path; do not inherit the original S620 294-530 Hz measurements
- validate buttons, pressure, proximity/reacquisition and long-run behavior
- source/pin a production factory image or define a same-device restore policy
- only then register a real `DeviceAdapter` in `ADAPTERS`

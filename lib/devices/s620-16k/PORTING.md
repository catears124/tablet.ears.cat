# Gaomon S620 (16K) port

Status: research scaffold only. This directory is intentionally **not** registered in `ADAPTERS` yet and nothing here is reachable from the flashing UI.

## Verified device fingerprint

Source: two byte-identical 128 KiB DFU reads from a 16K-pressure S620.

- normal USB: `256c:006f`
- DFU USB: `28e9:0189`
- normal-mode discriminator: string descriptor `0xc9`, `GM001_T263_260527`
- full backup SHA-256: `75849255b246dcffc4afa24a80ae33d0297e0caca81fd0c98fd9f0ea161db498`
- stock application: `0x08004000..0x0800cd24` (`0x8d24` / 36132 bytes)
- stock application SHA-256: `ec124d9675d3f35bb49f81b7e5f82f1dcada43f16d13d61fd571e3c87974212d`
- `0x0800d000..0x0800f800` is erased in the captured stock image, so the candidate extension base is `0x0800d000`
- digitizer: 33020 x 20320, pressure max 16383

The original S620 runtime base (`0x0800cc00`) is inside the 16K stock application and would overwrite `0x124` bytes of live firmware. Never reuse it.

## Verified code mappings

The USB/vendor-feature-report path is a near-exact relocated copy in the 16K firmware:

| original S620 | S620 (16K) | role |
| --- | --- | --- |
| `0x0800af00` | `0x0800b0e0` | feature-report helper |
| `0x0800aea4` | `0x0800b084` | feature-report helper |
| `0x0800b64c` | `0x0800b82c` | feature-report fallback |
| `0x0800b6d0` | `0x0800b8b0` | feature-report continuation |
| `0x0800b7bc` | `0x0800b99c` | feature-report dispatch |
| `0x0800b7c4` | `0x0800b9a4` | feature-report dispatch |
| descriptor `0x0800c579` | `0x0800c7e5` | feature report length byte (`0x07 -> 0x20`) |
| smoothing `0x08004a90` | `0x08004ac4` | coordinate smoothing helper |
| average `0x0800a04c` | `0x0800a23c` | averaging helper |
| delay `0x08006b2e` | `0x08006b96` | microsecond delay helper |
| barrel helper `0x08006cb4` | `0x08006d1c` | barrel-button rescan helper |

The three protocol hook preimages are byte-identical after relocation and the descriptor preimage remains `9507`, so protocol-only bring-up is the first hardware target.

Mapped data-path call sites, intentionally not enabled yet:

- averaging: `0x0800766e`, `0x0800767e`
- fast barrel buttons: `0x0800803c`, `0x080080c0`
- smoothing candidates: `0x080077be`, `0x080077d0`

## Why timing is not ported yet

The old S620 used four literal settle waits (27/20/30/150 us) and the current site maps requested Hz onto those four immediates. The 16K firmware rewrites that acquisition path: at least two waits are computed from a RAM value and the final literal wait is 120 us. Copying the old 294-530 Hz timing model would be technically wrong and could make a bootable-looking image unstable.

Likewise, 16K smoothing no longer has the old four identical calls with hardcoded weight `0x40`; the two mapped calls receive a dynamic weight. The old wrapper must be changed to preserve 16K stock semantics before those hooks are enabled.

## Bring-up order

1. Relocate and rebase the runtime to `0x0800d000`.
2. Enable only the three vendor-feature hooks plus the 32-byte descriptor length patch.
3. Verify boot/enumeration and GET_INFO/GET_CONFIG over WebHID.
4. Port averaging and fast-barrel hooks, then verify pen/pressure/buttons against stock behavior.
5. Fix the smoothing wrapper for the 16K calling convention.
6. Reverse/measure the 16K acquisition timing path and build a new rate model from hardware data.
7. Only then add a full `DeviceAdapter`, factory-image source/restore path, and register it in `ADAPTERS`.

No user-facing support should be claimed before step 7.

# AAP transport and battery contract

This document describes this implementation, not an official Apple protocol
specification or a claim of verification on every AirPods generation.

## Process ownership

`aap-session.js` owns one `Gio.Subprocess` for one connected, paired AirPods
identity. The C process owns one BR/EDR L2CAP `SOCK_SEQPACKET` connection to
PSM `0x1001`. The supervisor passes the observed local adapter address as
`--adapter`; it never guesses an adapter from a remote BLE address.

The extension waits for a retiring child to be reaped and its pipes to close
before a replacement can acquire that device's channel, including rapid
disconnect/reconnect, adapter changes and disable/enable.

Usage:

```text
headphones-battery-aap-helper --watch [--adapter LOCAL_MAC] REMOTE_MAC
headphones-battery-aap-helper --once  [--adapter LOCAL_MAC] REMOTE_MAC
headphones-battery-aap-helper --version
```

A MAC without a mode flag retains one-shot compatibility. The helper rejects
incomplete, overflowing or trailing address input. MACs are canonicalized to
uppercase. Production transport is not redirectable to a test socket or fixture
through command-line flags or environment variables.

Only the known handshake and notification subscription are sent. No noise
control, enable-features or key-retrieval command is included.

## Wire battery validation

The battery message prefix is `04 00 04 00 04 00`, followed by a count and
five-byte component records. Known component IDs are right `0x02`, left
`0x04`, case `0x08`.

The full record count, total length, constant bytes, duplicate component IDs
and recognized statuses are validated before any state is applied. A truncated
or malformed packet cannot partially update a device. Unknown component IDs
are not reinterpreted as a known earbud or case.

| Wire status | Meaning in this implementation | Percentage |
| --- | --- | --- |
| 0 | Unknown | Unavailable |
| 1 | Charging | Valid integer 0–100, otherwise unavailable |
| 2 | Discharging | Valid integer 0–100, otherwise unavailable |
| 4 | Disconnected | Unavailable, including wire value 0 |

A genuine connected zero is distinct from absence. Percentage values above 100
are unavailable. AAP packet transport and integer field size do not establish
the manufacturer's precise rounding or accuracy semantics.

## NDJSON version 1

Each accepted frame produces one bounded JSON line. Example with synthetic
addresses/measurements:

```json
{
  "version": 1,
  "type": "battery",
  "source": "aap",
  "address": "AA:BB:CC:DD:EE:FF",
  "present": ["left", "right"],
  "left": 57,
  "right": 93,
  "case": null,
  "charging": {"left": false, "right": false, "case": null},
  "status": {"left": "discharging", "right": "discharging", "case": null},
  "updated_at": 1793538000
}
```

`present` is the set of components in **this frame**, not the set of every
component ever observed. Absent components have null fields and their previous
measurement age is not reset. A present disconnected component invalidates its current value. The last valid
percentage is retained separately for display, with its original age and a
last-known label; it is never eligible for a playback estimate. Missing and zero are never interchangeable.

The JS boundary revalidates schema version, message type, source, expected
address, component keys, ranges and charging/status consistency. It rejects
unknown or malformed input without mutating state.

`updated_at` is diagnostic wall time. Freshness is based on local monotonic
receipt time. Parsing or receiving a case-only packet does not make an old
left/right value fresh.

## Time and resource limits

| Limit | Setting |
| --- | --- |
| Native connect deadline | 45 seconds |
| Native handshake deadline | 5 seconds |
| First battery frame after subscription | 10 seconds |
| Subscription refresh on the same connection | 60 seconds |
| Native no-battery timeout | 180 seconds |
| Supervisor startup watchdog | 70 seconds |
| Supervisor idle watchdog | 210 seconds |
| Retry base / cap | 5 / 300 seconds, jittered |
| Healthy period before retry counter reset | 30 seconds |
| Maximum stdout JSON line | 4096 bytes |

Connect completion is checked using `L2CAP_CONNINFO`, not an early `POLLOUT`
alone. I/O is nonblocking and bounded. SIGTERM/SIGINT, EOF, backpressure, broken
pipes, EINTR and truncated seqpacket messages are handled. The helper restores
the inherited stdout nonblocking flag on cooperative exit.

Exit codes: 0 normal/cooperative exit; 64 invalid arguments; 69 connection,
protocol, timeout or I/O failure; 77 access/setuid restrictions. Missing helper,
permission and invalid-configuration failures are terminal for that supervisor
instance, not an unbounded rapid retry loop.

## Source selection and freshness

Fresh AAP has priority over verified standard GATT LE, then Battery1, then
UPower/HFP. Fresh lower-priority measurements beat stale higher-priority ones.
Standard Battery1 does not imply 1% hardware precision just because its D-Bus
property is a byte.

| Source | Maximum observation age |
| --- | --- |
| AAP component | 900 seconds |
| Verified standard LE | 180 seconds |
| BlueZ Battery1 | 3600 seconds |
| UPower/HFP | 21600 seconds |

Transport loss can invalidate a source before those limits. Initial BlueZ
Battery1 cache is untrusted/stale until a property/interface event. UPower
initial cache uses a plausible UpdateTime; missing/future-dated timestamps
cannot claim freshness. Genuine measurement notifications use local receipt
time. UI refresh and metadata-only events are not measurements.

Fresh explicit AAP earbud disconnection suppresses older/equal generic
measurements when no other valid AAP earbud remains. A newer standard
measurement, AAP transport loss or expiry permits normal fallback. A case-only
update is not evidence that the earbuds disconnected.

Each eligible discharging earbud has a separate estimator record. The lower
active charge is the main percentage; the shorter eligible estimate is the
playback limit and the UI identifies its earbud. Charging/disconnected/stale
components and the case never contribute playback estimates.

## Primary references

- [podctl AAP implementation](https://github.com/Rockykln/podctl/blob/main/src/aap.rs)
- [LinuxPods battery decoder](https://github.com/mstroecker/LinuxPods/blob/main/src/aap/battery.rs)
- [LinuxPods AAP client](https://github.com/mstroecker/LinuxPods/blob/main/src/aap/client.rs)
- [BlueZ Device API](https://bluez.readthedocs.io/en/latest/device-api/)
- [UPower Device API](https://upower.freedesktop.org/docs/Device.html)
- [Gio.DBusObjectManagerClient](https://docs.gtk.org/gio/class.DBusObjectManagerClient.html)
- [Linux 6.8 L2CAP socket implementation](https://github.com/torvalds/linux/blob/v6.8/net/bluetooth/l2cap_sock.c)
- [GNOME extension loading and module caching](https://gjs.guide/extensions/development/creating.html)

These references inform transport/schema behavior. Their support claims and
hardware results are not attributed to this extension. No upstream license is
asserted for the application as a whole.


## Last-known component readings (version 4)

The version-2 state file also stores a `batteryHistory` map keyed by canonical
paired device identity. Each component stores its last measured percentage and
local wall-clock receipt time. Restore validates percentages and timestamps.
Restored history is always stale and display-only. Current source arbitration,
explicit disconnects and per-earbud estimation still use current observations.
The popup keeps all three rows visible for AirPods, with a separate music
forecast for each currently discharging earbud.

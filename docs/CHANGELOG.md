# Changelog

## 4.0.0 — 2026-11-23

- Add the source-built native AAP helper and supervised asynchronous session for
  paired AirPods, with separate left, right and case measurements.
- Retain each component's last valid percentage when it stops reporting, label
  its age, and restore it after reconnection or extension restart.
- Display each discharging earbud's own playback estimate; the shorter estimate
  drives the panel. Charging components and case charge never drive playback time.
- Discover connected headphones through BlueZ independently of UPower and retain
  the JBL Tune 520BT LE companion and HFP fallback paths.
- Preserve learned calibration with bounded asynchronous atomic state writes;
  restored measurements are display-only until new observations arrive.
- Include the source installer, backup/rollback, diagnostics, native parser and
  socketpair tests, GJS/D-Bus/subprocess tests, and extension orchestration tests.
- Extend CI to run the full suite, sanitizers, static checks and original
  estimator/pet rendering tests.

Live verification: both earbuds and case were received from the connected
AirPods Pro. Last-known percentages remained visible after closing the case
and after restarting the extension. Other AirPods generations remain unverified.

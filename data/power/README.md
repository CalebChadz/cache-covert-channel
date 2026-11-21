# Power-state runs

Runs tagged with the machine's power source, to test an open hypothesis: live
runs may succeed more often on battery than plugged in. Untested until there
are plugged-in runs to compare against.

| When (UTC) | Kind | Power | Result |
|---|---|---|---|
| 2026-11-21 04:02 | native `channel run cache` (`native-*.json`) | battery 90%, discharging (`pmset`) | clean: `cache`, 0/40 bit errors |
| 2026-11-21 04:02 | browser live, GitHub Pages, adaptive build (automation-driven) | battery 90%, not charging (`navigator.getBattery`) | live channel reached (2.4 MB probe, 2.48× pre-flight; others 0.9 MB 1.18×, 3.4 MB 1.87×, 6.8 MB 0.93×); both attempts corrupted (`c\`cleð`), checksum fail |
| 2026-11-21 04:05 | browser live, started by hand (`../browser/…04-05-27.json`) | battery (confirmed by the author; not in the file) | clean first attempt; P cores, 4.8 MB probe, 9.1× |
| 2026-11-21 04:06 | browser live, started by hand (`../browser/…04-06-11.json`) | battery (confirmed by the author; not in the file) | clean first attempt; P cores, 6.8 MB probe, 10.6× |
| 2026-11-21 (later) | native `channel run cache` | battery 100%, discharging (now recorded in the trace) | clean, 0/40 |
| 2026-11-21 (later) | browser live, local build, automation-driven | battery 100%, not charging (now recorded in the trace) | clean; E cores, 2.4 MB probe, 2.26× |

Browser calibration that run (receiver core): ~13–18 ns to 1.5 MB, 30 ns at
2 MB, 47 ns at 2.9 MB, 87 ns at 4 MB, ~200+ ns beyond, i.e. the efficiency
cluster's 4 MB L2. The full browser trace wasn't saved (export path
truncated); use the page's Save trace button for future runs.

From these runs on, power state is recorded automatically: the browser's
Save trace has a `power` field (Chromium only), native `channel --trace`
and `chase` record `pmset`/sysfs, and `native/batch.sh` adds a `power`
column.

Also on battery (confirmed by the author): six more hand-started browser runs,
2026-11-21 06:10–06:13 UTC, all intact on the performance cores. See
`../browser/README.md`.

**So far every run is on battery, so the hypothesis is still untested.**
Hand-started browser runs on battery: 8/8 intact. What's missing is the
same thing plugged in.

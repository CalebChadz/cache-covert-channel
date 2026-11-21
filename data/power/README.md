# Power-state runs

Runs tagged with the machine's power source, to test an open hypothesis: live
runs may succeed more often on battery than plugged in. Untested until there
are plugged-in runs to compare against.

| When (UTC) | Kind | Power | Result |
|---|---|---|---|
| 2026-11-21 04:02 | native `channel run cache` (`native-*.json`) | battery 90%, discharging (`pmset`) | clean: `cache`, 0/40 bit errors |
| 2026-11-21 04:02 | browser live, GitHub Pages, adaptive build | battery 90%, not charging (`navigator.getBattery`) | live channel reached (2.4 MB probe, 2.48× pre-flight; others 0.9 MB 1.18×, 3.4 MB 1.87×, 6.8 MB 0.93×); both attempts corrupted (`c\`cleð`), checksum fail |

Browser calibration that run (receiver core): ~13–18 ns to 1.5 MB, 30 ns at
2 MB, 47 ns at 2.9 MB, 87 ns at 4 MB, ~200+ ns beyond, i.e. the efficiency
cluster's 4 MB L2. The full browser trace wasn't saved (export path
truncated); use the page's Save trace button for future runs.

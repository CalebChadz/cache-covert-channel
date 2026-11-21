# Browser live traces

Saved with the demo's **Save trace** button (`cache-covert-channel/trace@1`).
All are from the author's MacBook (A18 Pro), Chrome, started by hand unless
noted.

| Trace (UTC) | Message | Core cluster (from calibration) | Probe chosen | Pre-flight | Result |
|---|---|---|---|---|---|
| 04:05:27 | `cache` | performance | 4.8 MB | 9.1× | clean, 1st attempt |
| 04:06:11 | `cache` | performance | 6.8 MB | 10.6× | clean, 1st attempt |
| 06:10:45 | `cache` | performance | 9.6 MB | 11.2× | clean, 1st attempt |
| 06:11:03 | `cache` (see note) | performance | 9.6 MB | 10.6× | clean, 1st attempt |
| 06:11:32 | `cache me outside` | performance | 9.6 MB | 10.7× | clean, 1st attempt |
| 06:12:14 | `cache me outside` | performance | 6.8 MB | 10.9× | clean, 2nd attempt (1st: `cáche me outside`, rejected by checksum) |
| 06:12:43 | `cache me outside` | performance | 9.6 MB | 11.3× | clean, 1st attempt |
| 06:13:11 | `cache me outside` | performance | 6.8 MB | 10.4× | clean, 1st attempt |

**8 of 8 decoded the full message intact** (7 on the first attempt).

Notes:

- **06:11:03 is mislabelled.** Its `sent` field says `cache me outside`, but
  it holds 160 samples, which is a `cache` frame (`cache me outside` is 336).
  The message box was edited before Save was pressed, and Save trace read the
  box at save time. Fixed: traces now record the message as it was when the
  run started. The file is left as captured.
- **Power: all eight were on battery**, as confirmed by the author (not
  recorded in the files themselves). They were run against a GitHub Pages
  build from before power logging was deployed (that deploy failed on a transient
  GitHub artifact error). Traces now also record the page URL and the build's
  git commit (`build.commit`), so this kind of mix-up is visible in the data.
- Automation-driven runs from the same day (not saved here) landed on the
  efficiency cores at 2–3× separation instead; see the article's "Adapting
  to the chip".

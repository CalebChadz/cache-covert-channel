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

## Naive linear walk in Safari and Chrome

`linear-chrome-2026-11-22.csv` is the same walk in Chrome after the fix: the
same steps, smaller at L1 (1.6× vs 2.3×) because its loop is slower there
(0.48 vs 0.27 ns per line).

`linear-safari-2026-11-22.csv` holds two live runs of the naive linear walk in
Safari, before and after the clock-rounding fix. The first run's steps were
clock ticks. The second run's steps are real: 0.27 ns per line up to 128 KB,
0.61–0.63 ns from 256 KB to 16 MB, then 0.90 and 2.20 ns at 32 and 64 MB.
`native/bandwidth.c`'s read-modify-write walk reproduces it
(`data/native/bandwidth-qos-p.csv`): these are bandwidth limits, which show
up because the compiled loop runs at about one cycle per line. Slowing the C
loop to ~1 ns per line (`bandwidth --pad 1`) makes the L1 step vanish.

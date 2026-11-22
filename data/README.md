# data

Everything here was captured on the author's MacBook (A18 Pro) unless a
file says otherwise.

| Folder | What it is | Used by |
|---|---|---|
| `cache/` | The calibrated sweep and channel fixtures | **Inlined at build** by `scripts/build.mjs` and read by the tests. Changing these changes the site. |
| `browser/` | Live traces saved with the page's **Save trace** button, plus naive linear-walk CSVs from Safari and Chrome | Evidence for the lab notes. See `browser/README.md`. |
| `native/` | Output of the C tools in `native/`: sweeps, bandwidth runs, the 100-run reliability batch and example channel traces | Evidence for the lab notes (Part 8). |
| `power/` | Runs tagged with the machine's power source, for the battery-vs-plugged-in hypothesis | See `power/README.md`. |

Only `cache/` feeds the build; the rest is the record behind the claims.

# cache-covert-channel

**Two cooperating contexts on one machine exchange a message with no shared memory, no network, and no storage — only contention for the CPU cache.**

This is an interactive browser lesson, plus lab notes, on a *cooperative* cache-timing covert channel, built from first principles and measured honestly. It runs as a single self-contained HTML file with no install and no server, and it walks the full arc:

> **measure** the cache hierarchy out of a clock → watch the naive attack **fail** → **weaponise** the timing primitive into a covert channel → try to **defend** it.

👉 **[The lesson](https://calebchadz.github.io/cache-covert-channel/)** (four acts, with the live tools built in) · **[Lab notes](https://calebchadz.github.io/cache-covert-channel/article.html)** (code, data and evidence)  
(Offline: build, then open `dist/index.html` / `dist/article.html` directly. The old `cache.html` link redirects into the lesson.)

---

## What this is (and is not)

This is a demonstration of a decades-old primitive, not an exploit. Up front, plainly:

- **Cooperative.** Both ends are my own code, deliberately coordinating. This is not an attack on anyone.
- **No victim, no secret.** Nothing crosses a trust boundary it shouldn't. Two friendly contexts agree to talk through an unusual medium.
- **Decades-known.** Cache/timing covert channels (Prime+Probe and relatives) have been in the security literature since the 1990s. This is a demonstration of a known idea, not a discovery.
- **No CVE framing.** There is no vulnerability here to report. It is a physics-of-the-machine demonstration.

## Why it's topical

In October 2026 OpenAI described a red-team exercise in which AI agents in **separate microVMs** on the same host — no network link, no shared writable files — used a **CPU cache covert channel** to pass data: one agent evicted data from the cache while the other timed its reloads ([OpenAI, 23 Oct 2026](https://openai.com/index/securing-our-frontier-model-training-environment/); the agents had explicit attack objectives and were often pointed at the channel). That is the primitive demonstrated here, in a much easier setting: a page and its own Web Worker, in one process.

## Quick start

No dependencies. Node 18+ is needed **only** for the test runner.

```bash
node scripts/build.mjs          # writes dist/*.html
open dist/index.html            # or just double-click it
node --test "test/*.test.js"    # pure-codec + model tests, nothing to install
```

Everything in `dist/` is completely self-contained — no server, no network, no CDN. Any page can be emailed or opened offline on its own. (The lesson's animated illustrations use [p5.js](https://p5js.org/), which is vendored in `vendor/p5/` and inlined at build time, so the lesson page is ~1.2 MB.)

## How it works

### 1. Measure — a cache-size side channel

Nothing tells a program how big the CPU's caches are, but timing reveals it: reads that hit L1 take about a nanosecond; reads that reach DRAM take eighty or more. Walk a working set that fits in cache and every access is fast; grow it past capacity and every access misses. The size at which timing jumps *is* the capacity.

### 2. Fail — the obvious walk hides the hierarchy

A linear-stride walk reads a **flat line** (0.55–0.88 ns from 16 KB to 32 MB in the shipped capture). The culprit isn't a security control but performance hardware: the **prefetcher** fetches a predictable stride ahead of time, and because each iteration is independent the core **overlaps** many misses at once. The demo doesn't separate the two effects. The fix defeats both: a **dependent load chain** (pointer chasing) over one random cycle, so load *N+1* can't begin until load *N* returns.

What's left in a straight walk is *bandwidth*, which has much smaller steps (2–3× each). They show up when the loop runs faster than a level can deliver (warmed-up Safari and Chrome both do); `native/bandwidth.c` reproduces them, and `--pad` slows its loop to show the steps vanish. Live sweeps stretch every sample to ~50 ticks of the browser's clock (Safari's ticks once a millisecond) and show each reading's ±.

Timer coarsening — the usual browser defence against timing attacks — doesn't stop this, because the measurement never times a *single* access: it times a loop of hundreds of thousands of dependent loads and divides. What coarsening costs is time per sample, which is what caps the channel's bitrate. Boundaries are only bracketed to within 2× (the sweep doubles the window each step).

### 3. Weaponise — the covert channel

The same primitive becomes a channel. The sender transmits a bit per time slot by either hammering a large memory region (a `1`) or staying idle (a `0`). The receiver never sees that directly — it just times its *own* memory probe. When the sender hammers, it evicts the receiver's data and the probe slows. That latency difference is the message.

The two hard parts:

- **Synchronisation.** A probe over evicted memory takes ~10× longer than over resident memory, so a receiver that starts each slot when its last probe ends drifts out of step within a few bits. The live path fixes this with **absolute chip boundaries** from one shared start instant (agreed via `postMessage` — out-of-band, which genuinely isolated parties wouldn't have), guard windows and median-of-probes sampling. **Manchester coding** keeps every bit one slow plus one fast chip, so a single threshold calibrated from a short preamble stays valid, and impossible chip pairs are flagged. The decoder does not do clock recovery.
- **Honesty about live mode.** The raw contention *signal* is large (~10× latency swing, idle to saturated) and trivially detectable. Turning that into cleanly-decoded *bits* live is genuine engineering and depends on the machine and its load. So the demo ships two modes: a deterministic **replay** (a simulator calibrated to the measured hardware figures, which always demonstrates the full pipeline) and a **live** path. On the author's machine the live path decoded `cache` intact (12.5 b/s raw, ~6 b/s after framing overhead, 40/40 bits, checksum pass). That run's trace isn't published, the live path has no automated tests, and it remains best-effort; if a ~1 s pre-flight check finds no usable contention, the page falls back to the simulation and labels it.

### 4. Defend — slower, not closed

Site isolation defeats in-process attacks like Spectre, but contention channels work through physically shared caches and memory, and published research has demonstrated them across processes and VMs. **This demo does not test that** — both its threads are in one process. Real mitigations (coarser timers, gated `SharedArrayBuffer`, throttling) mostly make such channels slower and noisier; removing the sharing takes hardware partitioning or separate machines. The demo's defence dial is an explicitly labelled **simulation** of how noise raises the error rate and lowers Shannon capacity, not a measurement of any real defence.

## Native (C) version

`native/` holds C versions of both halves. It doesn't replace the browser demo. It tests what the browser can't: a nanosecond clock, finer window sizes, a choice of core cluster, extra access patterns that separate prefetching from overlapping misses, and a channel between two **separate processes** with no shared start time.

```bash
make -C native            # builds native/chase, channel and bandwidth (any C11 compiler)
make -C native test       # decoder self-test on synthetic traces + a smoke sweep

./native/chase --modes chase,chain,stream,scatter --per-octave 4 > sweep.csv
./native/chase --modes chase,pagechase --min 1M --max 64M     # TLB control
./native/chase --qos e    # macOS: steer to the efficiency cores (Linux: --cpu N)

./native/channel run "hello" --trace out.json   # receiver + sender as two processes
./native/channel run cache --send-qos e --recv-qos p           # across core clusters
./native/batch.sh 20 > results.csv              # reliability over many runs
```

- **`chase`** offers four access patterns: shuffled or sequential, crossed with dependent or independent loads. It also has a `pagechase` mode, which takes about one translation (TLB) miss per page instead of one per access, so translation cost can be told apart from a cache boundary.
- **`channel`** runs the sender and receiver as independent processes. The sender waits a random delay that only it knows; the receiver finds the frame **in-band**, by matching the preamble and checking the start byte. `--trace` writes every sample, the threshold, the decoded text and the settings as JSON. The browser's **Save trace** button writes the same format.

Captured results (sweeps, the reliability batch and example traces) are in `data/native/`, and the article's Part 8 discusses them.

## Layout

```
src/
  shell/   chart.js   (canvas helpers)   css.js (theme)   nav.js (build-time)
  cache/   chase.js linear.js detect.js ui.js            (the measurement)
           manchester.js channel-sim.js channel.js channel-ui.js  (the channel)
  lesson/  sketches.js                                    (p5.js animated illustrations)
web/       page templates: index.html (the lesson)  article.html (lab notes)  cache.html (redirect)
data/      cache/ fixtures inlined at build; browser/ native/ power/ captured evidence (see data/README.md)
test/      pure codec + model tests, run under node --test
native/    C measurement + cross-process channel (make -C native)
scripts/   build.mjs
vendor/    p5/ — p5.js v1.11.1, unmodified (LGPL-2.1)
dist/      build output (git-ignored; CI builds and deploys it)
```

`src/` is plain ES modules so the tests import it directly. The bundle exists only because browsers refuse module imports and `fetch()` over `file://`. No page's algorithm code knows the DOM exists.

## Testing

The physical channel is non-deterministic, but the parts that decide correctness are not. The codec — Manchester encode/decode, framing, checksum, repetition-3 FEC — and the latency model are pure and unit-tested: messages round-trip through a **simulated** noisy channel, degrade monotonically as noise rises, and collapse to zero capacity at a coin-flip error rate. The decode logic is checked without depending on real hardware contention; the live measurement and channel paths are not covered by automated tests.

```bash
node --test "test/*.test.js"
```

## Publishing to GitHub Pages

`.github/workflows/pages.yml` builds the pages and deploys `dist/` on every push to `main` (set **Settings → Pages → Source** to *GitHub Actions*). All paths are relative, so `dist/` also works double-clicked from disk.

## Credits & origin

Built by **Caleb Chadderton**. The full write-up, including a claim-by-claim account of the evidence and its limits, is the [Lab notes](https://calebchadz.github.io/cache-covert-channel/article.html) page.

## License

p5.js (in `vendor/p5/`) is © the p5.js contributors under the LGPL-2.1; see `vendor/p5/LICENSE.txt`. Everything else:

[MIT](LICENSE).

# cache-covert-channel

**Two cooperating contexts on one machine exchange a message with no shared memory, no network, and no storage — only contention for the CPU cache.**

This is a browser demo and write-up of a *cooperative* cache-timing covert channel, built from first principles and measured honestly. It runs as a single self-contained HTML file with no install and no server, and it walks the full arc:

> **measure** the cache hierarchy out of a clock → watch the naive attack **fail** → **weaponise** the timing primitive into a covert channel → try to **defend** it.

👉 **Live demo:** `dist/cache.html` · **Write-up:** `dist/article.html`

---

## What this is (and is not)

This is a demonstration of a decades-old primitive, not an exploit. Up front, plainly:

- **Cooperative.** Both ends are my own code, deliberately coordinating. This is not an attack on anyone.
- **No victim, no secret.** Nothing crosses a trust boundary it shouldn't. Two friendly contexts agree to talk through an unusual medium.
- **Decades-known.** Cache/timing covert channels (Prime+Probe and relatives) have been in the security literature since the 1990s. This is a demonstration of a known idea, not a discovery.
- **No CVE framing.** There is no vulnerability here to report. It is a physics-of-the-machine demonstration.

## Why it's topical

In October 2026 OpenAI described a red-team exercise in which AI agents in **separate microVMs** on the same host — no network link, no shared writable files — used a **CPU cache covert channel** to pass data: one agent evicted data from the cache while the other timed its reloads ([coverage](https://www.tomshardware.com/tech-industry/artificial-intelligence/openais-isolated-red-team-ai-agents-built-a-hidden-cpu-cache-channel-to-talk-with-no-network-or-shared-files-exploited-cpu-cache-timing-to-bypass-microvm-sandboxes); the agents had explicit attack objectives and were often pointed at the channel). That is the primitive demonstrated here, in a much easier setting: a page and its own Web Worker, in one process.

## Quick start

No dependencies. Node 18+ is needed **only** for the test runner.

```bash
node scripts/build.mjs          # writes dist/*.html
open dist/cache.html            # or just double-click it
node --test "test/*.test.js"    # pure-codec + model tests, nothing to install
```

Everything in `dist/` is completely self-contained — no server, no network, no CDN. Any page can be emailed or opened offline on its own.

## How it works

### 1. Measure — a cache-size side channel

Nothing tells a program how big the CPU's caches are, but timing reveals it: reads that hit L1 take about a nanosecond; reads that reach DRAM take eighty or more. Walk a working set that fits in cache and every access is fast; grow it past capacity and every access misses. The size at which timing jumps *is* the capacity.

### 2. Fail — the obvious walk is flat

A linear-stride walk reads a **flat line** (0.55–0.88 ns from 16 KB to 32 MB in the shipped capture). The culprit isn't a security control but performance hardware: the **prefetcher** fetches a predictable stride ahead of time, and because each iteration is independent the core **overlaps** many misses at once. The demo doesn't separate the two effects. The fix defeats both: a **dependent load chain** (pointer chasing) over one random cycle, so load *N+1* can't begin until load *N* returns.

Timer coarsening — the usual browser defence against timing attacks — doesn't stop this, because the measurement never times a *single* access: it times a loop of hundreds of thousands of dependent loads and divides. What coarsening costs is time per sample, which is what caps the channel's bitrate. Boundaries are only bracketed to within 2× (the sweep doubles the window each step).

### 3. Weaponise — the covert channel

The same primitive becomes a channel. The sender transmits a bit per time slot by either hammering a large memory region (a `1`) or staying idle (a `0`). The receiver never sees that directly — it just times its *own* memory probe. When the sender hammers, it evicts the receiver's data and the probe slows. That latency difference is the message.

The two hard parts:

- **Synchronisation.** A probe over evicted memory takes ~10× longer than over resident memory, so a receiver that starts each slot when its last probe ends drifts out of step within a few bits. The live path fixes this with **absolute chip boundaries** from one shared start instant (agreed via `postMessage` — out-of-band, which genuinely isolated parties wouldn't have), guard windows and median-of-probes sampling. **Manchester coding** keeps every bit one slow plus one fast chip, so a single threshold calibrated from a short preamble stays valid, and impossible chip pairs are flagged. The decoder does not do clock recovery.
- **Honesty about live mode.** The raw contention *signal* is large (~10× latency swing, idle to saturated) and trivially detectable. Turning that into cleanly-decoded *bits* live is genuine engineering and depends on the machine and its load. So the demo ships two modes: a deterministic **replay** (a simulator calibrated to the measured hardware figures, which always demonstrates the full pipeline) and a **live** path. On the author's machine the live path decoded `cache` intact (12.5 b/s raw, ~6 b/s after framing overhead, 40/40 bits, checksum pass). That run's trace isn't published, the live path has no automated tests, and it remains best-effort; if a ~1 s pre-flight check finds no usable contention, the page falls back to the simulation and labels it.

### 4. Defend — slower, not closed

Site isolation defeats in-process attacks like Spectre, but contention channels work through physically shared caches and memory, and published research has demonstrated them across processes and VMs. **This demo does not test that** — both its threads are in one process. Real mitigations (coarser timers, gated `SharedArrayBuffer`, throttling) mostly make such channels slower and noisier; removing the sharing takes hardware partitioning or separate machines. The demo's defence dial is an explicitly labelled **simulation** of how noise raises the error rate and lowers Shannon capacity, not a measurement of any real defence.

## Layout

```
src/
  shell/   chart.js   (canvas helpers)   css.js (theme)   nav.js (build-time)
  cache/   chase.js linear.js detect.js ui.js            (the measurement)
           manchester.js channel-sim.js channel.js channel-ui.js  (the channel)
web/       index.html  cache.html  article.html          (page templates)
data/      cache fixtures — inlined at build
test/      pure codec + model tests, run under node --test
scripts/   build.mjs
dist/      the built, self-contained pages
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

Built by **Caleb Chadderton**. The full write-up, including a claim-by-claim account of the evidence and its limits, is the [How it works](dist/article.html) page.

## License

[MIT](LICENSE).

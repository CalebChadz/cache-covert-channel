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

In October 2026 OpenAI published an internal red-team result: two AI agents placed in **separate microVMs** on the same host — no network link, no shared files — built a **CPU cache covert channel** and used it to pass data, one agent evicting data from the cache while the other timed how long it took to reload. That is exactly the primitive demonstrated here; the only difference is the parties (two isolated agents there, a page and its Web Worker here). The lesson is the same: you can cut the network, restrict syscalls, and separate processes, and timing on a physically shared cache still leaks.

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

### 2. Fail — the prefetcher hides the signal

The original 2020 version walked memory with a linear stride and read a **flat line** across a 2000× range of working-set sizes. The culprit wasn't a security control — it was the **hardware prefetcher**, a performance feature that recognises a linear pattern and streams lines in before they're requested, so the miss latency never appears. The fix is a **dependent load chain** (pointer chasing): lay the working set out as one random cycle where each slot holds the address of the next, so load *N+1* can't begin until load *N* returns and the prefetcher has nothing to predict.

Timer coarsening — the usual browser defence against timing attacks — doesn't stop this, because the measurement never times a *single* access. It times a loop of hundreds of thousands of dependent loads and divides, so a 100 µs clock quantum is a rounding error.

### 3. Weaponise — the covert channel

The same primitive becomes a channel. The sender transmits a bit per time slot by either hammering a large memory region (a `1`) or staying idle (a `0`). The receiver never sees that directly — it just times its *own* memory probe. When the sender hammers, it evicts the receiver's data and the probe slows. That latency difference is the message.

The two hard parts:

- **Synchronisation.** A probe over evicted memory takes ~10× longer than over resident memory, so a naive fixed-slot scheme drifts out of sync within a few bits. The fix is **Manchester coding** — every bit is sent as a transition, so the signal carries its own clock and the receiver re-locks on every bit. A short raw preamble calibrates the fast/slow threshold before the message begins.
- **Honesty about live mode.** The raw contention *signal* is large (~10× latency swing, idle to saturated) and trivially detectable. Turning that into cleanly-decoded *bits* live is genuine engineering and depends on the machine and its load. So the demo ships two modes: a deterministic **replay** (a simulator calibrated to the measured hardware figures, which always demonstrates the full pipeline) and a **live** path. The live path is verified — on the author's hardware it decoded a short message intact at 12.5 b/s with a 0% bit-error rate and a passing checksum — and remains best-effort across arbitrary machines and background load.

### 4. Defend — a capacity dial, not a kill switch

The counterintuitive part: **site isolation does not close this channel.** Site isolation puts cross-origin pages in separate processes, which defeats in-process attacks like Spectre — but the last-level cache and memory bus are physically shared across every core and process, so a contention channel survives process and site isolation. What actually limits it — timer coarsening, withholding the high-resolution `SharedArrayBuffer` timer unless cross-origin isolated, scheduler throttling — *reduces capacity and reliability* without cleanly zeroing the channel. You can't un-share a cache in software. The demo's defence controls reflect this: a timer-coarsening toggle and a quality slider that make the error rate climb and the Shannon capacity fall, but never quite to zero without making the channel useless.

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

The physical channel is non-deterministic, but the parts that decide correctness are not. The codec — Manchester encode/decode, framing, checksum, repetition-3 FEC — and the latency model are pure and fully tested: messages round-trip through a **simulated** noisy channel, degrade monotonically as noise rises, and collapse to zero capacity at a coin-flip error rate. The decode logic is verified without depending on real hardware contention.

```bash
node --test "test/*.test.js"
```

## Publishing to GitHub Pages

All paths are relative, so `dist/` works as-is. In **Settings → Pages**, serve from a branch/folder that exposes `dist/` (for example copy `dist/*` into a `docs/` folder, or publish the `dist/` contents to a `gh-pages` branch). The landing page is `index.html`.

## Credits & origin

Cache side-channel and surrounding projects began as University of Waikato coursework (COMPX304), 2020; rebuilt and extended into this covert-channel demonstration in 2026 by **Caleb Chadderton**. Defects found while porting the original are catalogued in [`cache-side-channel-explained.md`](cache-side-channel-explained.md).

## License

[MIT](LICENSE).

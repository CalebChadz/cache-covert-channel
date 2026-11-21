# How it works: reading a CPU cache with a stopwatch

*A from-scratch tour of the cache side-channel and covert-channel demos in this
project — what the machine is really doing, and why the first version lied to me
for six years.*

This is the explainer for the Cache Side Channel page. That page lets you run the
experiment; this one teaches the ideas behind it, starting from "what is a cache"
and ending at two programs talking to each other through nothing but shared
silicon. No security background assumed. If you can read a few lines of
JavaScript, you can follow all of it — and, if you like, reproduce it yourself
from the code in this repository.

> **The honest framing, up front.** Nothing here is an attack on anyone. It
> measures *my own* computer, and later has two of my own programs cooperate on
> purpose. It leaks no one's data, uses techniques that have been in the textbooks
> since the 1990s, and is **not** a vulnerability or a CVE. It is a demonstration
> of how the physical machine behaves — which is exactly the kind of thing a
> security analyst should be able to reason about.

---

## Part 1 — Why computers need a cache at all

A modern CPU can do a few billion operations a second. Each operation usually
needs a piece of data, and most data lives in main memory (RAM). Here is the
uncomfortable fact the whole story hangs on: **the CPU is far faster than the
memory it reads from.** Fetching a value from RAM can cost the processor the
equivalent of a couple of hundred wasted cycles — hundreds of ticks of doing
nothing but waiting. This is the *memory-speed gap*, and it has been widening for
decades.

An analogy. Imagine a chef who can chop and stir almost instantly, but whose
ingredients are stored in a warehouse a ten-minute drive away. It doesn't matter
how fast the chef is; if every carrot requires a round trip, the kitchen crawls.
The obvious fix is to keep the ingredients you're using *right now* on the
counter, the ones you'll need soon in the fridge, and only the bulk supply in the
warehouse. That is exactly what a CPU cache is: a small, very fast store of
memory physically close to the processor, holding copies of the data it is most
likely to need next.

Caches work because real programs are predictable in two ways. They reuse the
same data soon after using it (*temporal locality*), and they use data that sits
near data they just used (*spatial locality*). So the hardware keeps
recently-touched memory close, and fetches memory in small blocks — a **cache
line**, usually 64 bytes — rather than one byte at a time, betting you'll want the
neighbours too.

### The hierarchy: smaller is faster

You can't have it all. Fast memory is expensive and physically has to be tiny and
close to the core; big memory is cheap but far away and slow. So chips build a
*hierarchy* — several caches of increasing size and decreasing speed — and let
data fall through it. The counter, the fridge, the pantry, the warehouse.

| Level | Size | Typical speed |
|---|---|---|
| CPU registers | ~1 KB | < 1 ns |
| L1 cache | tens of KB | ~1 ns |
| L2 cache | a few MB | ~5 ns |
| L3 / system-level cache (SLC) | tens of MB | ~10–30 ns |
| main memory (DRAM) | many GB | ~80+ ns |

*(Nanosecond figures are from my own machine, measured in Part 3; yours will
differ, but the shape is universal.)*

L1 is tiny and answers in about a nanosecond. L2 is larger and a few times
slower. Below that sits a last-level cache — often called the L3 or, on Apple
silicon, a *system-level cache* (SLC) — shared between cores and larger still.
Miss all of those and you pay the full trip to DRAM. When the CPU looks for a
value it checks each level in turn; the first level that has it answers.

---

## Part 2 — Hits, misses, and what timing tells you

When the data the CPU wants is already in a cache, that's a **cache hit** — fast.
When it isn't, that's a **cache miss**, and the request falls to the next level
down, costing more time. The deeper it has to go, the longer you wait. A hit
might cost ~1 ns; a miss all the way to DRAM ~80 ns. The check is the same in both
cases — the difference is pure waiting, and it's roughly 80× longer on a miss.

> **The one idea to hold onto:** the time a memory read takes tells you *where the
> data was*. Fast means it was in a nearby cache; slow means it had to come from
> far away. So a clock is secretly a probe into the memory hierarchy. Nothing in a
> CPU offers an API that says "your L2 is 4 MB" — but the timing gives it away.
> Information leaking through a physical property of the machine, rather than
> through an interface designed to provide it, is what **side channel** means.

---

## Part 3 — Measuring the hierarchy by timing

Here is the plan, and it's beautifully simple. Take a chunk of memory of some
size — the *working set* — and read through it over and over, timing how long the
average read takes. Then do it again with a bigger chunk, and bigger, and bigger.

While the whole working set fits inside a cache level, every read is a hit and the
average is fast. The moment the working set grows past that level's capacity, the
reads start spilling to the next level down and the average jumps. **The size at
which the timing jumps is the capacity of that cache level.** Plot average latency
against working-set size and you get a staircase; each step — each "knee" — marks
a boundary in the hierarchy.

One trick makes or breaks this, and it's the pivot of the whole story: *how* you
walk through memory matters enormously. The corrected experiment uses a **pointer
chase** (a dependent-load chain). You scatter the working set into a single long
loop, where the value stored at each slot is the location of the next slot to
visit. To take a step you must read the current slot to find out where to go next.

```js
// src/cache/chase.js — laying out the loop
// Lay out a single random cycle over `windowBytes` worth of cache lines,
// so slot perm[0] -> perm[1] -> ... -> perm[n-1] -> back to perm[0].
export function buildChain(buf, windowBytes, seed = 12345) {
  const n = Math.floor(windowBytes / LINE_BYTES);   // one slot per 64-byte line
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  // ... shuffle perm[] into a random order ...
  for (let i = 0; i < n; i++) {
    buf[perm[i] * STRIDE] = perm[(i + 1) % n] * STRIDE;  // each slot stores the NEXT slot's index
  }
  return n;
}
```

Then the measurement itself is just this loop, timed:

```js
// src/cache/chase.js — the timed region
const t0 = performance.now();
for (let i = 0; i < steps; i++) p = buf[p];   // the next read's address comes FROM the last read
const t1 = performance.now();
return ((t1 - t0) * 1e6) / steps;      // total time / hops = nanoseconds per access
```

That single line, `p = buf[p]`, is the heart of it. Each read depends on the
result of the one before, so the CPU cannot run ahead — it must finish read *N*
before it even knows the address of read *N+1*. Every access therefore pays the
true latency of wherever that slot currently lives. (Why that matters so much is
Part 4.) We don't time a single read — the browser's clock is far too coarse for
that — we time hundreds of thousands of them and divide, which is why a blunt
clock is fine here.

Turning the curve into named boundaries is a separate, careful step. The 2020
original declared a cache size at the first point where latency rose 1.5× — with
no repeats, no noise floor, and no check that the curve had any real range at all.
The rewrite refuses to guess:

```js
// src/cache/detect.js — refusing to invent a boundary
export function detectKnees(points, { minRatio = 1.4, minRange = 3 } = {}) {
  const range = dynamicRange(points);   // slowest reading / fastest reading
  if (range < minRange) {
    // A flat curve has no hierarchy to report. Naming a boundary here
    // would be inventing one — which is exactly the original's bug.
    return { knees: [], range, confident: false };
  }
  // otherwise: flag every step whose ratio clears minRatio as a knee
}
```

Why that guard exists at all is the next part.

---

## Part 4 — The plot twist: the original was measuring the wrong thing

When I first ported the 2020 program faithfully and ran it, the curve came out
**flat**. Not roughly flat — *flat*: about 0.55 to 0.88 nanoseconds per access
from 16 KB all the way to 32 MB, a two-thousand-fold range of working-set sizes
with no knee anywhere. According to its own measurement, this machine had no cache
hierarchy at all. Something was clearly wrong, and it took me a while to accept
what.

The original walked memory with a **linear stride**: read byte 0, then byte 64,
then byte 128, straight through in order. The faithful port of that inner loop is:

```js
// src/cache/linear.js — the faithful 2020 pass
const modu = windowBytes - 1;
for (let i = 0; i < steps; i++) {
  bytes[(i * 64) & modu] &= 1;   // address = i*64, wrapped to the window: 0, 64, 128, 192, ...
}
```

That access pattern is a perfectly straight line through memory — and that is
precisely the problem. Modern CPUs contain a **hardware prefetcher**: a little
unit whose entire job is to watch your memory accesses, spot regular patterns, and
fetch upcoming data into cache *before* the program asks for it. A straight
64-byte march is the most predictable pattern that exists. The prefetcher
recognises it instantly and streams the next lines in ahead of demand.

Back to the kitchen: the prefetcher is an assistant who has learned your routine.
Because you always reach for the next ingredient down the row, the assistant runs
to the warehouse and lines them all up on the counter before you ask. The misses
still happen — the data still had to come from far away — but you never *wait* for
them, so their latency never shows up in your timing. The 2020 program wasn't
measuring cache capacity. It was measuring how fast the assistant could stream
ingredients in a straight line: sequential memory *bandwidth*, which is roughly
constant regardless of working-set size. That's why the line is flat.

**The measured pointer-chase curve on the author's own hardware, next to the 2020
linear stride's characteristic flat result:**

| working set | 2020 linear stride (ns)\* | pointer chase (ns) |
|---|--:|--:|
| 32 KB | 0.6 | 1.6 |
| 128 KB | 0.5 | 1.6 |
| 192 KB | — | 4.2 |
| 256 KB | 0.8 | 4.5 |
| 1 MB | 0.8 | 5.8 |
| 4 MB | 0.8 | 7.4 |
| 16 MB | 0.8 | 11.75 |
| 24 MB | — | 19.25 |
| 32 MB | 0.9 | 39 |
| 64 MB | — | 72.5 |
| 128 MB | — | 104.5 |

\*The linear column is the 2020 mode's flat signature; those figures are
illustrative (it wasn't re-swept on this machine), but the whole point is that it
stays flat regardless of size.

The linear stride reports no hierarchy: ~0.6–0.9 ns everywhere. The pointer chase
climbs ~70× — from ~1.6 ns in L1 to 104.5 ns at 128 MB — with a sharp knee at the
128 KB L1 boundary (a 2.6× jump, 1.6→4.2 ns, at 192 KB) and a staircase through
L2, an intermediate ~24 MB system-level-cache shoulder, and DRAM. The only
difference between the two columns is the *order the reads happen in*.

> **This is the most consequential finding in the whole repository:** the 2020
> program's reported cache size was never actually derived from its measurement.
> Its "detector" was picking the first spot where a flat, noisy line happened to
> twitch 1.5× upward — reporting scheduler jitter as a cache boundary. It printed
> a confident number for six years, and that number meant nothing. I only found
> out by rebuilding it and measuring, not by reading it.

The lesson generalises well beyond this toy. The thing that defeated the original
wasn't a security control someone added to stop the attack — it was a performance
optimisation, put there for unrelated reasons, quietly erasing the exact signal
the attack relied on. A lot of security work is exactly this: the behaviour that
matters is not in the algorithm's description, it's in what the silicon actually
does when you run it.

---

## Part 5 — The fix, and why the pointer chase beats the prefetcher

Now the pointer chase makes sense. The prefetcher can only run ahead when it can
*predict* the next address. With a linear stride the next address is trivially
"current + 64". With a pointer chase, the next address is whatever value the
current slot happens to hold — and because the slots were shuffled into a random
cycle, that address is effectively unpredictable. The prefetcher has nothing to
run ahead on. Each read must complete before the next address is even known, so
the CPU genuinely stalls on every miss, and the true latency finally appears in
the timing.

Swap the linear walk for the dependent-load chain and the flat line becomes a
textbook staircase — the pointer-chase column above. Same machine, same coarse
clock, same everything, except now we're measuring capacity instead of bandwidth.
One line of code — *where the next address comes from* — is the whole difference.

> **Aside — but doesn't the browser blunt the clock on purpose?** Yes. Browsers
> coarsen `performance.now()` (to 100 µs in Chrome outside a special isolated
> context, 1 ms in Firefox/Safari) specifically to frustrate timing attacks. It
> doesn't obstruct *this* measurement, because coarsening defeats timing a
> *single* access — and we never do that. We time a loop that runs for
> milliseconds and divide, so a 100 µs quantum is a rounding error. The defence I
> expected to be the obstacle wasn't the obstacle; a performance feature was.

---

## Part 6 — Reality check: does it match the real hardware?

A pretty staircase is one thing; a staircase that lands on the actual numbers is
another. So the measured curve was checked against a published cache hierarchy —
and it holds up well enough to be worth walking through, including where it
doesn't.

> **Provenance, stated plainly.** The latency curve in this article is now
> **measured on my own hardware** — a fine-grained sweep run in Chrome 153, a
> non-isolated context, on a 6-core / 8 GB Apple Silicon machine. (Chrome's
> user-agent string still says "Intel Mac OS X"; that is the *frozen* UA Chrome
> reports on Apple Silicon, not a real Intel Mac — worth knowing so you don't
> misread it.) The figures I compare it against are the **published specifications
> for Apple's A18 Pro** (cited below), so this section is "my measured curve versus
> the published hierarchy." Where they agree I say *measured, confirmed*; where the
> sweep can't see something I say so.

**The L1 boundary lands exactly.** The A18 Pro's performance core is published with
a **128 KB L1 data cache**. My curve is flat at about 1.5–1.9 ns/access through the
32, 64 and 128 KB windows, then jumps 2.6× — 1.6 ns to 4.2 ns — at 192 KB. That is
precisely the fingerprint of a 128 KB cache: the working set still fits at 128 KB
and stops fitting just past it. The measurement pins the published L1d capacity
exactly, from my own machine.

**It recovers latency too — with an honest correction.** The flat L1 reading is
about **1.5–1.6 ns/access**. At the A18 Pro's published 4.04 GHz P-core clock that
is roughly **6 cycles** — a few cycles *above* the ~3–4-cycle L1 load-to-use latency
documented for Apple's performance cores (via the closely related Firestorm design).
The gap is not a mystery: each "access" here is a bounds-checked JavaScript array
index plus loop overhead riding on top of the real hardware load, so the method
reads a few cycles high. It recovers the cache's *capacity* on the nose and its
*latency* to the right order — a handful of cycles — but the absolute cycle count
carries a constant software tax. (An earlier draft, from a different environment,
quoted 1.05 ns ≈ 4.2 cycles; my own run is slower, and this is the corrected figure.
Trust the measurement over the tidier number.)

**Past L1 it degrades honestly — and the finer sweep sees more than the old one
did:**

- The **L2 cache (published 16 MB)** resolves approximately: a plateau near 5.4–5.9
  ns holds from ~384 KB to ~2 MB, then a gentle shoulder climbs to 11.75 ns by
  16 MB, where the working set starts leaving L2 (the 16 MB → 24 MB step rises 1.64×).
- The **system-level cache (~24 MB)** — which the old coarse power-of-two sweep
  *missed entirely* — now shows up. Because this fine sweep has a sample at 24 MB, it
  catches an intermediate tier at **~19 ns**, sitting between the L2 edge (~12 ns at
  16 MB) and full DRAM (39 ns at 32 MB). That is exactly where a ~24 MB SLC should
  appear. It is a shoulder on a climb rather than a clean plateau, and the SLC size
  is the least-certain published figure (The Apple Wiki flags it), so I'd call it
  *plausibly resolved* — but it went from invisible to visible purely by sampling
  finer.
- **DRAM** resolves: latency climbs past the caches to 39 ns at 32 MB and on to
  **104.5 ns at 128 MB** — a thoroughly believable main-memory latency. (The
  transition is gradual — no single step clears the 1.4× bar past 32 MB — so it
  registers as a slope, not a discrete knee.)

### The detector, and the boundaries it does and doesn't name

Run the fixed knee detector on this curve and it confidently reports two boundaries:
**128 KB and 24 MB**. Its *raw* (pre-merge) list is three — 128 KB, 16 MB, 24 MB —
and here is the subtlety worth the whole section. The merge rule exists because on
the earlier coarse sweep the detector invented a phantom cache at **8 MB**: no such
cache exists; it was the L2 rolloff shoulder compounded by the **TLB** (the small
address-translation table) running out — roughly 160 entries over 16 KB pages reach
only ~2.5 MB before translation misses add their own latency. Merging consecutive
above-threshold steps correctly kills that ghost.

> But look what the same merge does here. On this finer data the two steps it
> collapses — 16 MB (leaving L2) and 24 MB (leaving the SLC) — are *both real, and
> different levels*. The rule tuned to stop the tool *inventing* a boundary now makes
> it *hide* one. That is the prefetcher plot twist a third time: in Part 4 the
> instrument hid a real boundary, earlier in this part it invented a fake one, and
> here a well-meaning fix does both at once — merging a genuine L2 edge into the SLC
> edge. The tool lies in every direction, and only knowing the hardware lets you read
> past it. The raw list (128 KB / 16 MB / 24 MB) is actually the more faithful map of
> this chip; the merged headline (128 KB / 24 MB) is the safer default. Both are
> shown on the page on purpose.

| Published spec (A18 Pro) | Measured on the author's hardware | Verdict |
|---|---|---|
| L1d — 128 KB | flat ≤ 128 KB, 2.6× jump (1.6→4.2 ns) at 192 KB | pinned exactly |
| L1 load-to-use — ~3–4 cycles | ~1.5–1.6 ns ≈ ~6 cycles @ 4.04 GHz | right order; reads a few cycles high (JS overhead) |
| L2 — 16 MB | ~5.4–5.9 ns plateau to ~2 MB; leaves L2 by 16 MB (11.75 ns) | resolves approximately |
| SLC — ~24 MB *(uncertain)* | intermediate ~19 ns tier at 24 MB, between L2 and DRAM | now plausibly resolved (fine sweep only) |
| DRAM | 39 ns @ 32 MB → 104.5 ns @ 128 MB | confirmed |
| *(none — 8 MB)* | old coarse sweep's false knee | corrected: TLB/rolloff, not a cache |

*Dynamic range of the measured curve: ~70× (1.5 ns to 104.5 ns). Every "published
spec" figure is a specification (cited below); every "measured" figure is from the
author's own sweep of this chip.*

---

## Part 7 — The finale: turning the clock into a covert channel

So far the timing primitive only reads a harmless fact about my own hardware. The
finale puts it to work: it lets two separate programs on the same machine **talk
to each other** using nothing but the shared cache — no shared variables, no
network, no files, no messages passed between them. Just contention for the same
silicon.

The setup is two contexts: a *sender* running in a Web Worker (a separate thread)
and a *receiver* running on the main page. The trick is that they share the
last-level cache and the memory bus, because on a real chip those are physically
shared across cores.

```
   SENDER (Worker)              SHARED CACHE            RECEIVER (page)
  ┌───────────────┐            + memory bus           ┌────────────────┐
  │ send 1: hammer │  evicts  ┌──────────────┐ slows  │ times its OWN   │
  │        24 MB   │ ───────► │  physically  │ ─────► │ probe:          │
  │ send 0: stay   │          │   shared     │        │  ~90 ns → a 1   │
  │        quiet   │          └──────────────┘        │   ~9 ns → a 0   │
  └───────────────┘                                    └────────────────┘

   No shared memory. No network. No storage.
   The only thing crossing the gap is contention for the cache.
   The receiver never sees the sender — it only notices its own reads got slower.
```

On the wire a `1` is the sender saturating a big memory region for a time slot; a
`0` is the sender resting. The saturation evicts the receiver's data from the
shared cache, so when the receiver runs the very same pointer-chase probe from
Part 3, it comes back slow. Quiet sender → fast probe → the receiver reads a `0`.
The sender's loop is deliberately tight and non-yielding, because a bursty sender
produces almost no signal:

```js
// src/cache/channel.js — the sender, running in a Worker
// A '1' chip: saturate the memory subsystem continuously for ~a few ms.
function thrash(ms){
  const step = 64; let acc = 0; const t0 = performance.now();
  while (performance.now() - t0 < ms){
    for (let i=0;i<buf.length;i+=step) acc ^= buf[i];  // stream a big region, over and over
  }
  return acc;
}
```

```js
// src/cache/channel.js — the receiver's probe (a dependent-load chain, as before)
return function probeNs(steps) {
  let p = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) p = buf[p];  // same pointer chase — its speed reveals whether we were evicted
  const t1 = performance.now();
  return ((t1 - t0) * 1e6) / steps;
};
```

Raw, the contrast is not subtle. In the feasibility measurements the receiver's
probe read about **8.7 ns/access** with the sender idle and **90.3 ns/access**
with the sender thrashing — roughly a **10× swing**, trivially visible even
through the coarse 100 µs clock. The simulator that drives the reliable "replay"
demo is calibrated straight to those figures:

```js
// src/cache/channel-sim.js — the model, straight from the measured hardware
export const MODEL = {
  idleNs: 9,   // receiver probe when the sender is quiet (region still resident)
  busyNs: 90,  // receiver probe when the sender saturates the cache/bus
};
```

### Why the signal is easy but the message is hard

Here's the surprise, and it's the intellectual centre of the finale: *detecting*
the sender is easy, but turning that into a reliable stream of bits is genuinely
hard — and the hard part is not the signal, it's the **synchronisation**. The two
ends have to agree on where each bit slot begins and ends. My first attempts used
simple fixed time slots against a shared wall clock, and they decoded at a
bit-error rate around 0.5 — no better than flipping a coin — despite a clear 6–9×
separation sitting right there in the raw samples. The signal was present; the
*clocking* was broken.

The reason is subtle and worth savouring: the receiver's own probe takes about ten
times longer when the region is evicted (during a `1`) than when it's resident
(during a `0`). So the receiver's measurement runs slow during exactly the bits
that are `1`, its probe overruns the slot, and the two ends drift apart within a
few bits. The very thing being measured distorts the measurement's timing.

The textbook fix is **Manchester coding**, self-clocking by design. Instead of
"high = 1, low = 0", every bit is sent as a *transition* within its slot: a `1` is
occupy-then-idle, a `0` is idle-then-occupy. Because every single bit contains an
edge, the receiver recovers the clock from the signal itself and re-locks on every
bit, so drift can't accumulate:

```js
// src/cache/manchester.js — every bit carries its own clock edge
export const CHIPS_FOR_1 = [1, 0];   // data 1 -> occupy, then idle
export const CHIPS_FOR_0 = [0, 1];   // data 0 -> idle, then occupy

export function manchesterEncode(bits) {
  const chips = [];
  for (const b of bits) chips.push(...(b ? CHIPS_FOR_1 : CHIPS_FOR_0));
  return chips;
}
```

```
 bit:     1         0         1         1
 occupy ──┐     ┌───┐     ┌───┐     ┌───┐
          │     │   │     │   │     │   │
 idle     └─────┘   └─────┘   └─────┘   └───
          ▲edge ▲edge ▲edge ▲edge   ← a transition in the middle of every slot
```

A short *preamble* of raw alternating chips leads each message, so the receiver
can lock its phase and calibrate its fast/slow threshold from the real channel
before the payload begins. There's an optional repetition-3 error-correcting code
(send each bit three times, take the majority) so the page can show raw versus
corrected side by side — the errors are displayed, not hidden. All of that codec
logic is pure and deterministic, so it's unit-tested against synthetic traces
without needing flaky real hardware in the loop. The realistic reliable bitrate
for this coarse-timed channel is modest — single digits to low tens of bits per
second — which is completely fine: "a few bytes per second, through nothing but
the cache" is the striking part, not the speed.

### It works live — confirmed on real hardware

That bitrate estimate is no longer just a projection. The live channel was run
end-to-end on the author's own machine and it **decoded**. With the sender hammering
and the receiver timing its own probe — no shared memory, no network, no storage —
the message `cache` arrived **intact**: raw bitrate **12.5 bits/s**, and with the
error-correcting code switched *off*, a post-decode **bit-error rate of 0.0%** and a
passing checksum. A handful of individual chips did flip — visible as red points
early in the latency trace — but the preamble's threshold calibration and
Manchester's self-clocking recovered the framing, so the whole word still came
through. That is the entire pipeline from the top of this article, carrying real
bits through nothing but contention for the cache.

The honest caveats stay exactly as they were: this is **best-effort**. It depends on
the machine and its background load, the bitrate is deliberately low, and on a busy
laptop a live run may not land clean bits at all — which is why the page still ships
the deterministic replay as the always-works fallback. What changed is only that
"live decode is unverified" has become "live decode is verified, on this hardware,
under these conditions." Confirmed real, not just simulated.

> **A one-bit ghost: the day it decoded "cacHe".** On a different live run the same
> message came back as `cacHe` — a capital H in the middle of an otherwise perfect
> word. That is not a glitch in the demo; it is the channel telling the truth about
> itself. Lowercase `h` is `0x68` = `0110 1000`; uppercase `H` is `0x48` =
> `0100 1000`. They differ by exactly **one bit** — `0x20`, the ASCII "case" bit. So
> a single chip flipped by cache noise silently changed one letter's case and left
> every other bit untouched. It is hard to imagine a cleaner illustration of two
> things at once: (a) the channel really is carrying real bits subject to real
> physical noise, and (b) exactly why error-correcting codes and a whole-message
> checksum belong in any serious design — one flipped bit is the whole distance
> between `cache` and `cacHe`, and only the FEC or the checksum would catch it.

### The defence — a dial, not a switch

The obvious question is: how do you stop this? A common intuition is that **site
isolation** — the browser putting different origins in different operating-system
processes — should close it. It doesn't, and saying so honestly is a better lesson
than repeating the myth. Site isolation defends against a different attack: one
origin's code speculatively reading another origin's memory *inside the same
process*, which is the Spectre family. But a cache covert channel doesn't read
anyone's memory. It works through contention, and the last-level cache and memory
bus are **physically shared across cores and processes**. Two separate processes
still fight over the same silicon, so this channel *survives* process and site
isolation.

What actually helps are measures that degrade the channel's *capacity*: coarsening
the timer, withholding the high-resolution `SharedArrayBuffer` counter unless a
page is cross-origin isolated, and throttling background threads. On the demo you
can toggle timer coarsening and drag a quality slider and watch the bit-error rate
climb and the Shannon capacity fall. But none of them drives it cleanly to zero
without also making legitimate timing useless, because — the honest bottom line —
**you cannot un-share a cache in software.** The mitigations raise the attacker's
cost and lower the bandwidth. They are mitigations, not fixes. That "reduced, not
eliminated" reality is the more interesting security truth, and it's the note the
finale ends on.

---

## Part 8 — Replicate it yourself

Everything above is in this repository, and it's built to be run. No framework, no
install step for the demos themselves, and every page is a single self-contained
file.

**What's in the repo:**

- `src/cache/chase.js` — the corrected pointer-chase measurement.
- `src/cache/linear.js` — the faithful 2020 linear-stride pass, kept so you can
  see it fail.
- `src/cache/detect.js` — turns a curve into cache boundaries, and refuses to when
  there's no real range.
- `src/cache/manchester.js` — the self-clocking codec: bytes → bits → chips and
  back, with preamble, framing and checksum.
- `src/cache/channel.js` — the live physical channel: the Worker sender and the
  constant-work receiver probe.
- `src/cache/channel-sim.js` — the deterministic simulator behind the always-works
  replay demo and the defence sliders.
- `data/cache/fixtures.json` — the captured latency curve the live page plots in
  "captured run" mode. (Part 6's figures are from a finer sweep on the author's own
  machine; the demo's captured curve is an earlier validation run.)
- `BUGS.md` — every defect found while porting, marked FIXED / GUARDED / OPEN /
  N/A. Defect #1 is the prefetcher story.

**How to run it.** You need [Node.js](https://nodejs.org/) (v18+) only to build the
pages and run the tests; the built pages themselves need nothing. From the
`portfolio/` folder:

```sh
npm run verify   # runs the unit tests, then rebuilds dist/ and runs the post-build checks
npm run build    # just rebuild the self-contained pages into dist/
```

Then open `dist/cache.html` in a browser — double-click it, no server needed.
Choose **"Pointer chase — live on this machine"** and hit Run to measure *your*
hierarchy; switch to **"2020 algorithm — live"** to watch the same clock report a
flat line on the same machine. Scroll to the finale to send a short message
through the cache and play with the defence dial.

**Two experiments worth trying:**

1. **Watch the prefetcher win.** Run the pointer-chase mode and note the
   staircase. Now run the 2020 linear mode over the same size range: the knees
   vanish and the line goes flat. That gap is the prefetcher hiding every miss. If
   you're comfortable editing code, change the pointer chase in `chase.js` back to
   a linear stride and watch the curve collapse — that's the experiment that
   started this.
2. **Watch the error rate climb.** In the finale, tick "coarsen the receiver's
   timer" and drag the channel-quality slider down. The bit-error rate rises and
   the capacity readout falls — a live demonstration of what a countermeasure
   actually buys, and of the fact that it degrades the channel without ever quite
   closing it.

---

## Where to go deeper

- **Caches and the memory-speed gap:** Ulrich Drepper, *What Every Programmer
  Should Know About Memory* (2007) — the canonical deep-dive.
  <https://www.akkadia.org/drepper/cpumemory.pdf>. A gentler start is Wikipedia's
  [CPU cache](https://en.wikipedia.org/wiki/CPU_cache) article.
- **Prefetching** (the Part 4 villain): Wikipedia,
  [Cache prefetching](https://en.wikipedia.org/wiki/Cache_prefetching).
- **The A18 Pro hardware figures** (the Part 6 published specs):
  [The Apple Wiki — A18 Pro](https://theapplewiki.com/wiki/A18_Pro) for cache sizes
  (L1d 128 KB, L2 16 MB per P-core; the ~24 MB system-level cache is flagged
  uncertain) and clock. Apple P-core L1 load-to-use latency is documented for the
  closely related Firestorm core at
  [7-CPU — Apple M1](https://www.7-cpu.com/cpu/Apple_M1.html) (3–4 cycles). General
  background: [Wikipedia — Apple A18](https://en.wikipedia.org/wiki/Apple_A18).
- **Cache timing as an attack primitive:** Colin Percival, *Cache Missing for Fun
  and Profit* (2005) — very readable, and the paper that popularised cache covert
  channels between threads. <https://www.daemonology.net/papers/htt.pdf>. The
  classic Prime+Probe treatment is Osvik, Shamir & Tromer, *Cache Attacks and
  Countermeasures: the Case of AES* (2006), <https://eprint.iacr.org/2005/271>.
- **Cache attacks in the browser** (closest to this demo): Oren et al., *The Spy in
  the Sandbox — Practical Cache Attacks in JavaScript* (2015),
  <https://arxiv.org/abs/1502.07373>.
- **Spectre** (why the timer defences exist): Kocher et al., *Spectre Attacks*
  (2019), <https://spectreattack.com/spectre.pdf>.
- **Covert & side channels, background:** Wikipedia,
  [Covert channel](https://en.wikipedia.org/wiki/Covert_channel) and
  [Side-channel attack](https://en.wikipedia.org/wiki/Side-channel_attack).
- **The browser's timing defences:** MDN on
  [performance.now()](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)
  and
  [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
  (and the COOP/COEP isolation it needs).

---

*One more time, because it matters: this is cooperative and educational. It leaks
no one's data, it measures only my own machine, the techniques are decades old and
well documented above, and there is no vulnerability here to report. The point was
never to break something — it was to understand what the machine is really doing,
closely enough to tell the difference between what a program claims to measure and
what it actually measures. That difference is where the interesting security
questions live.*

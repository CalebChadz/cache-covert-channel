// Turning a latency curve into cache boundaries.
//
// The naive heuristic is: walk the measurements in order, and the first
// time a pass takes 1.5x the previous one, declare that the cache size. With no
// repetition, no noise floor and no check that a signal exists at all, it will
// happily report a boundary from scheduler jitter on a completely flat curve -
// and it reports the window AFTER the jump, overstating capacity by up to 2x.
// `originalHeuristic()` below reproduces it so the page can show the contrast.
//
// `detectKnees()` is the replacement: it looks at every step ratio, keeps those
// above a threshold, and refuses to report anything when the curve has no
// meaningful dynamic range.

// Exported because the page bundle concatenates these modules into one scope,
// so a second top-level `const MB` elsewhere would be a redeclaration error.
export const MB = 1024 * 1024;

export function formatBytes(b) {
  if (b >= MB) return `${b / MB} MB`;
  if (b >= 1024) return `${b / 1024} KB`;
  return `${b} B`;
}

// Ratio of each measurement to the one before it.
export function stepRatios(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push({
      fromBytes: points[i - 1].bytes,
      toBytes: points[i].bytes,
      ratio: points[i].ns / points[i - 1].ns,
    });
  }
  return out;
}

// Total spread of the curve. A working measurement spans roughly L1 to DRAM,
// which is one to two orders of magnitude. A flat curve sits near 1.
export function dynamicRange(points) {
  if (points.length < 2) return 1;
  const ns = points.map((p) => p.ns);
  return Math.max(...ns) / Math.min(...ns);
}

// A jump between window S and window 2S means the working set stopped fitting
// somewhere in that interval, so the level's capacity is approximately S.
//
// Returns both the corrected `knees` (with gradual rolloffs merged) and the
// unmerged `rawKnees` (every supra-threshold step). The raw list is kept on
// purpose: a detector can invent a boundary the hardware does not have, and
// the merge rule that prevents that can also hide a real one. The page shows
// both lists rather than picking one silently.
export function detectKnees(points, { minRatio = 1.4, minRange = 3, minTicks = 3 } = {}) {
  if (points.length < 3) {
    return { knees: [], rawKnees: [], merged: [], range: 1, confident: false };
  }

  const range = dynamicRange(points);
  if (range < minRange) {
    // No hierarchy is visible. Reporting a boundary here would be inventing
    // one, which is precisely the original's failure mode.
    return { knees: [], rawKnees: [], merged: [], range, confident: false };
  }

  // A jump only counts if it's bigger than the clock can fake. When a point
  // records its resolution (one clock tick, in ns/access), a step smaller than
  // `minTicks` ticks could be pure rounding: 1 tick → 2 ticks reads as "2×".
  const resolvable = (i) => {
    const a = points[i - 1], b = points[i];
    const res = Math.max(a.resolutionNs || 0, b.resolutionNs || 0);
    return !res || (b.ns - a.ns) >= minTicks * res;
  };
  const steps = stepRatios(points).map((s, k) => (resolvable(k + 1) ? s : { ...s, ratio: Math.min(s.ratio, 1) }));
  const toKnee = (s) => ({
    capacityBytes: s.fromBytes,
    atBytes: s.toBytes,
    ratio: s.ratio,
    label: `~${formatBytes(s.fromBytes)}`,
  });

  // Every supra-threshold step, before merging - what a naive detector reports.
  const rawKnees = steps.filter((s) => s.ratio >= minRatio).map(toKnee);

  // Merge consecutive supra-threshold steps. A single gradual rolloff (a cache
  // level tailing off, or L2-shoulder-plus-TLB effects) shows up as two adjacent
  // windows both clearing the threshold, and counting each as its own boundary
  // invents a level that does not exist - e.g. the 8 MB artefact on the A18 Pro,
  // which barely clears the threshold at 1.47x and sits between the real L2 and
  // SLC/DRAM edges. When two consecutive steps are both supra-threshold, treat
  // them as one boundary located at the steeper step, so a two-step rolloff
  // yields a single knee instead of two.
  const knees = [];
  const merged = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.ratio < minRatio) continue;

    const next = steps[i + 1];
    if (next && next.ratio >= minRatio) {
      const steeper = next.ratio >= s.ratio ? next : s;
      const weaker = steeper === next ? s : next;
      knees.push(toKnee(steeper));
      merged.push({
        kept: `~${formatBytes(steeper.fromBytes)}`,
        absorbed: `~${formatBytes(weaker.fromBytes)}`,
      });
      i++; // the paired step is consumed by this boundary
    } else {
      knees.push(toKnee(s));
    }
  }

  return { knees, rawKnees, merged, range, confident: knees.length > 0 };
}

// The naive first-jump detector, reproduced. Returns the size it would have reported, or
// null. Note it compares against the previous measurement with no smoothing,
// takes the FIRST crossing, and has no notion of whether the curve is flat.
export function originalHeuristic(points, threshold = 1.5) {
  for (let i = 1; i < points.length; i++) {
    if (points[i].ns / points[i - 1].ns > threshold) {
      return { reportedBytes: points[i].bytes, atIndex: i };
    }
  }
  return null;
}

// Plain-language summary for the page.
export function describe(points, mode) {
  const { knees, rawKnees, merged, range, confident } = detectKnees(points);
  const orig = originalHeuristic(points);

  if (mode === 'linear') {
    if (!confident) {
      return {
        headline: 'No cache boundary detectable',
        detail:
          `The curve spans only ${range.toFixed(2)}x from its fastest to slowest window. ` +
          `A working measurement spans 10x or more. The prefetcher is hiding the misses, ` +
          `so this is measuring streaming bandwidth rather than cache capacity.` +
          (orig
            ? ` A naive first-jump detector would nonetheless have reported ${formatBytes(orig.reportedBytes)} — from noise.`
            : ''),
        tone: 'err',
      };
    }
    // Structure that only appears once the window is bigger than any on-chip
    // cache is most likely the memory-bandwidth wall: prefetching hides
    // latency, but it can't make DRAM deliver bytes any faster.
    const firstAt = Math.min(...knees.map((k) => k.capacityBytes));
    if (firstAt >= 8 * MB) {
      return {
        headline: `Flat up to ~${formatBytes(firstAt)}, then a gentle rise`,
        detail:
          `Below ~${formatBytes(firstAt)} the walk stays flat: prefetching and overlapping hide the latency. ` +
          `Past that it no longer fits in on-chip cache and streams from main memory, which is most likely ` +
          `limited by memory bandwidth, something no prefetcher can hide. Total spread ${range.toFixed(1)}x, ` +
          `still far less than a pointer chase over the same sizes.`,
        tone: 'warn',
      };
    }
    return {
      headline: 'Unexpected structure in the linear sweep',
      detail:
        `Dynamic range ${range.toFixed(2)}x. This mode usually stays flat at small sizes, so a busy ` +
        `machine is the likeliest cause. Try closing other tabs and running again.`,
      tone: 'warn',
    };
  }

  if (!confident) {
    return {
      headline: 'No clear boundary',
      detail:
        `Dynamic range is only ${range.toFixed(2)}x. The machine may be busy, or the ` +
        `sweep may not extend past the last level of cache. Try a wider range or close other tabs.`,
      tone: 'warn',
    };
  }

  // If merging removed one or more boundaries, say so - the raw list is a
  // teaching moment about a detector inventing levels, not something to bury.
  const mergeNote = merged.length
    ? ` A naive detector would report ${rawKnees.length} (${rawKnees.map((k) => k.label).join(', ')}); ` +
      `the extra ${merged.map((m) => m.absorbed).join(', ')} ` +
      `${merged.length === 1 ? 'is a' : 'are'} gradual rolloff, not a separate cache — merged into the adjacent edge.`
    : '';

  return {
    headline:
      knees.length === 1
        ? `Cache boundary near ${knees[0].label}`
        : `${knees.length} boundaries: ${knees.map((k) => k.label).join(', ')}`,
    detail:
      `Latency spans ${range.toFixed(0)}x from the smallest window to the largest. ` +
      `Each step is where the working set stopped fitting in a level of cache.` +
      mergeNote,
    tone: 'ok',
  };
}

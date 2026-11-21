// native/chase.c — cache-hierarchy measurement in C, with the controls the
// browser version can't have.
//
// Four access patterns, a 2x2 of {sequential, shuffled} x {dependent, independent}:
//
//   chase   shuffled  + dependent    the pointer chase (same idea as src/cache/chase.js)
//   chain   sequential + dependent   prefetchable, but every load waits for the last
//   stream  sequential + independent the naive linear walk (src/cache/linear.js)
//   scatter shuffled  + independent  unprefetchable, but loads can overlap
//
// plus a control for address translation:
//
//   pagechase  like chase, but visits pages in random order and finishes every
//              line of a page (in random order) before leaving it. Still
//              unpredictable and dependent, but it takes one TLB miss per page
//              instead of roughly one per access. If `chase` rises where
//              `pagechase` stays flat, the rise is translation (TLB) cost, not
//              a cache running out.
//
// Comparing them separates the two effects the article could only name
// together: if `chain` shows the staircase, serialisation (not the prefetcher's
// absence) is what exposes latency; if `scatter` is flat, overlapping misses
// (memory-level parallelism) hide it even without prefetching.
//
// Also: a nanosecond clock, windows between the powers of two (--per-octave),
// and a core-cluster hint (--qos p|e on macOS, --cpu N on Linux).
//
// Output is CSV on stdout; progress goes to stderr.
//
//   make chase && ./chase --modes chase,stream --per-octave 4 > sweep.csv

#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/utsname.h>
#include <unistd.h>

#include "common.h"

#define LINE 64
#define KB 1024ull
#define MB (1024ull * 1024ull)

// Each cache line is one node. Dependent modes store a pointer to the next
// node in the first word of the line; independent modes read that same word.
typedef struct node { struct node *next; char pad[LINE - sizeof(void *)]; } node;

static volatile uint64_t sink; // defeats dead-code elimination

static uint64_t rng_state = 0x9E3779B97F4A7C15ull;
static inline uint64_t rng(void) { // xorshift64*
  rng_state ^= rng_state >> 12; rng_state ^= rng_state << 25; rng_state ^= rng_state >> 27;
  return rng_state * 0x2545F4914F6CDD1Dull;
}

static void shuffle(uint32_t *a, size_t n) {
  for (size_t i = n - 1; i > 0; i--) {
    size_t j = (size_t)(rng() % (i + 1));
    uint32_t t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

typedef enum { M_CHASE, M_CHAIN, M_STREAM, M_SCATTER, M_PAGECHASE } mode_t_;
static const char *MODE_NAMES[] = { "chase", "chain", "stream", "scatter", "pagechase" };
#define NMODES 5
static size_t page_lines = 16384 / LINE; // set from the real page size in main()

// Lay out the working set for a mode. `order` is the visit order (identity for
// sequential, shuffled otherwise); dependent modes link it into one cycle.
static void prepare(node *buf, uint32_t *order, size_t n, mode_t_ m) {
  for (size_t i = 0; i < n; i++) order[i] = (uint32_t)i;
  if (m == M_CHASE || m == M_SCATTER) shuffle(order, n);
  if (m == M_PAGECHASE) {
    // shuffle the pages, then shuffle the lines inside each page
    size_t pages = (n + page_lines - 1) / page_lines;
    uint32_t *pg = malloc(pages * sizeof *pg);
    for (size_t i = 0; i < pages; i++) pg[i] = (uint32_t)i;
    shuffle(pg, pages);
    size_t k = 0;
    for (size_t i = 0; i < pages; i++) {
      size_t start = k;
      for (size_t l = 0; l < page_lines; l++) {
        size_t idx = (size_t)pg[i] * page_lines + l;
        if (idx < n) order[k++] = (uint32_t)idx;
      }
      if (k - start > 1) shuffle(order + start, k - start);
    }
    free(pg);
  }
  for (size_t i = 0; i < n; i++) buf[order[i]].next = &buf[order[(i + 1) % n]];
}

// Run `steps` accesses; returns elapsed ns.
static uint64_t run(node *buf, const uint32_t *order, size_t n, mode_t_ m, uint64_t steps) {
  uint64_t t0, t1, acc = 0;
  if (m == M_CHASE || m == M_CHAIN || m == M_PAGECHASE) {
    node *p = &buf[order[0]];
    t0 = now_ns();
    for (uint64_t s = 0; s < steps; s++) p = p->next;   // load N+1 needs load N
    t1 = now_ns();
    acc = (uint64_t)(uintptr_t)p;
  } else if (m == M_STREAM) {
    size_t i = 0;
    t0 = now_ns();
    for (uint64_t s = 0; s < steps; s++) {             // independent, sequential
      acc += (uint64_t)(uintptr_t)buf[i].next;
      if (++i == n) i = 0;
    }
    t1 = now_ns();
  } else { // M_SCATTER
    size_t i = 0;
    t0 = now_ns();
    for (uint64_t s = 0; s < steps; s++) {             // independent, shuffled
      acc += (uint64_t)(uintptr_t)buf[order[i]].next;  // (order[] itself is read sequentially)
      if (++i == n) i = 0;
    }
    t1 = now_ns();
  }
  sink += acc;
  return t1 - t0;
}

static int cmp_d(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

// ns per access for one window: calibrate the step count so each timed run
// lasts ~target_ms, warm with one full pass, then take `repeats` samples.
static void measure(node *buf, uint32_t *order, size_t n, mode_t_ m, int repeats,
                    double target_ms, double *med, double *mn, double *mx, uint64_t *steps_out) {
  prepare(buf, order, n, m);
  run(buf, order, n, m, n > 20000 ? n : 20000);                 // warm caches + TLB
  uint64_t probe = 20000;
  double per = (double)run(buf, order, n, m, probe) / (double)probe;
  uint64_t steps = (uint64_t)(target_ms * 1e6 / (per > 0.05 ? per : 0.05));
  if (steps < 100000) steps = 100000;
  if (steps > 200000000) steps = 200000000;
  double v[64];
  if (repeats > 64) repeats = 64;
  for (int r = 0; r < repeats; r++) v[r] = (double)run(buf, order, n, m, steps) / (double)steps;
  qsort(v, (size_t)repeats, sizeof v[0], cmp_d);
  *med = v[(repeats - 1) / 2]; *mn = v[0]; *mx = v[repeats - 1]; *steps_out = steps;
}

static size_t parse_size(const char *s) {
  char *end; double v = strtod(s, &end);
  if (*end == 'K' || *end == 'k') v *= KB;
  else if (*end == 'M' || *end == 'm') v *= MB;
  else if (*end == 'G' || *end == 'g') v *= 1024.0 * MB;
  return (size_t)v;
}

static void usage(void) {
  fprintf(stderr,
    "usage: chase [--modes chase,chain,stream,scatter,pagechase] [--min 16K] [--max 128M]\n"
    "             [--per-octave N] [--repeats N] [--target-ms N] [--seed N]\n"
    "             [--qos p|e|default]   (macOS: steer to performance/efficiency cores)\n"
    "             [--cpu N]             (Linux: pin to CPU N)\n");
}


int main(int argc, char **argv) {
  const char *modes = "chase,chain,stream,scatter", *qos = "default";
  size_t lo = 16 * KB, hi = 128 * MB;
  int per_octave = 4, repeats = 5, cpu = -1;
  double target_ms = 20;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(a, "--modes") && v) { modes = v; i++; }
    else if (!strcmp(a, "--min") && v) { lo = parse_size(v); i++; }
    else if (!strcmp(a, "--max") && v) { hi = parse_size(v); i++; }
    else if (!strcmp(a, "--per-octave") && v) { per_octave = atoi(v); i++; }
    else if (!strcmp(a, "--repeats") && v) { repeats = atoi(v); i++; }
    else if (!strcmp(a, "--target-ms") && v) { target_ms = atof(v); i++; }
    else if (!strcmp(a, "--seed") && v) { rng_state = strtoull(v, NULL, 0) | 1; i++; }
    else if (!strcmp(a, "--qos") && v) { qos = v; i++; }
    else if (!strcmp(a, "--cpu") && v) { cpu = atoi(v); i++; }
    else { usage(); return 2; }
  }
  if (lo < 2 * LINE || hi < lo || per_octave < 1 || repeats < 1) { usage(); return 2; }

  set_core_hint(qos, cpu);

  { long ps = sysconf(_SC_PAGESIZE); if (ps >= LINE) page_lines = (size_t)ps / LINE; }
  size_t nmax = hi / LINE;
  node *buf = NULL;
  if (posix_memalign((void **)&buf, 16384, nmax * sizeof(node))) { perror("alloc"); return 1; }
  memset(buf, 0, nmax * sizeof(node)); // back every page now, not mid-measurement
  uint32_t *order = malloc(nmax * sizeof(uint32_t));
  if (!order) { perror("alloc"); return 1; }

  char mach[256]; machine_line(mach, sizeof mach);
  time_t now = time(NULL); char date[32];
  strftime(date, sizeof date, "%Y-%m-%d", localtime(&now));
  printf("# cache-covert-channel native/chase.c\n# machine: %s\n# date: %s\n", mach, date);
  { char pw[384]; power_json(pw, sizeof pw); printf("# power: %s\n", pw); }
  printf("# qos: %s  repeats: %d  target_ms: %.0f  per_octave: %d\n", qos, repeats, target_ms, per_octave);
  printf("mode,qos,window_bytes,ns_median,ns_min,ns_max,steps\n");

  char mlist[128]; snprintf(mlist, sizeof mlist, "%s", modes);
  for (char *tok = strtok(mlist, ","); tok; tok = strtok(NULL, ",")) {
    int m = -1;
    for (int k = 0; k < NMODES; k++) if (!strcmp(tok, MODE_NAMES[k])) m = k;
    if (m < 0) { fprintf(stderr, "unknown mode: %s\n", tok); return 2; }
    // windows lo * 2^(k/per_octave), rounded to whole lines, deduplicated
    size_t prev = 0;
    for (int k = 0;; k++) {
      double w = (double)lo * __builtin_pow(2.0, (double)k / per_octave);
      size_t bytes = ((size_t)(w + 0.5) / LINE) * LINE;
      if (bytes > hi) break;
      if (bytes == prev) continue;
      prev = bytes;
      double med, mn, mx; uint64_t steps;
      measure(buf, order, bytes / LINE, (mode_t_)m, repeats, target_ms, &med, &mn, &mx, &steps);
      printf("%s,%s,%zu,%.3f,%.3f,%.3f,%llu\n", MODE_NAMES[m], qos, bytes, med, mn, mx,
             (unsigned long long)steps);
      fflush(stdout);
      fprintf(stderr, "\r%-8s %9.1f KB  %8.2f ns   ", MODE_NAMES[m], bytes / 1024.0, med);
    }
    fprintf(stderr, "\n");
  }
  free(order); free(buf);
  return 0;
}

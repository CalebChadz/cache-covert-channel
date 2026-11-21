// native/bandwidth.c — how fast a STRAIGHT walk can go, per cache level.
//
// The pointer chase (chase.c) measures latency: how long one read waits. A
// straight walk measures something else: how fast each level can deliver
// data. That has its own steps, but you only see them if the loop itself is
// fast enough to outrun the cache. chase.c's `stream` mode costs ~3 cycles per
// line in loop overhead, which hides them. This walk does ~1 cycle per line:
//
//   read   8 independent accumulators, one load per 64-byte line
//   rmw    bytes[i*64] &= 1, the browser's naive loop (src/cache/linear.js),
//          which also has to write every line back
//
// A Safari run of the naive walk (JavaScriptCore compiles it to roughly this)
// matched the `rmw` column closely; see the lab notes, section 2.
//
//   make bandwidth && ./bandwidth --qos p > bandwidth.csv

#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "common.h"

#define LINE 64

static volatile uint64_t sink;

static double walk_read(const uint8_t *b, size_t bytes, uint64_t lines) {
  uint64_t a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0, a6 = 0, a7 = 0;
  size_t n = bytes / LINE, i = 0;
  uint64_t t0 = now_ns();
  for (uint64_t s = 0; s < lines; s += 8) {
    a0 += b[(i + 0) * LINE]; a1 += b[(i + 1) * LINE]; a2 += b[(i + 2) * LINE]; a3 += b[(i + 3) * LINE];
    a4 += b[(i + 4) * LINE]; a5 += b[(i + 5) * LINE]; a6 += b[(i + 6) * LINE]; a7 += b[(i + 7) * LINE];
    i += 8; if (i >= n) i = 0;
  }
  uint64_t t1 = now_ns();
  sink += a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
  return (double)(t1 - t0) / (double)lines;
}

// `pad` adds that many dependent multiplies per line: a loop-carried chain
// that sets a floor on how fast the loop can go (~3 cycles each), without
// touching memory. It stands in for a less tightly compiled loop, to test
// whether a slow enough loop hides the bandwidth steps.
static double walk_rmw(uint8_t *b, size_t bytes, uint64_t lines, int pad) {
  volatile uint8_t *v = b;
  size_t n = bytes / LINE, i = 0;
  uint64_t x = 1;
  uint64_t t0 = now_ns();
  for (uint64_t s = 0; s < lines; s += 8) {
    for (int k = 0; k < 8; k++) {
      v[(i + k) * LINE] &= 1;
      for (int j = 0; j < pad; j++) x = x * 6364136223846793005ull + 1442695040888963407ull;
    }
    i += 8; if (i >= n) i = 0;
  }
  uint64_t t1 = now_ns();
  sink += x;
  return (double)(t1 - t0) / (double)lines;
}

static int cmp_d(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static size_t parse_size(const char *s) {
  char *end; double v = strtod(s, &end);
  if (*end == 'K' || *end == 'k') v *= 1024;
  else if (*end == 'M' || *end == 'm') v *= 1024 * 1024;
  return (size_t)v;
}

int main(int argc, char **argv) {
  size_t lo = 32 * 1024, hi = 128u * 1024 * 1024;
  int repeats = 5, pad = 0; double target_ms = 20; const char *qos = "default"; int cpu = -1;
  for (int a = 1; a < argc; a++) {
    if (!strcmp(argv[a], "--min") && a + 1 < argc) lo = parse_size(argv[++a]);
    else if (!strcmp(argv[a], "--max") && a + 1 < argc) hi = parse_size(argv[++a]);
    else if (!strcmp(argv[a], "--repeats") && a + 1 < argc) repeats = atoi(argv[++a]);
    else if (!strcmp(argv[a], "--target-ms") && a + 1 < argc) target_ms = atof(argv[++a]);
    else if (!strcmp(argv[a], "--qos") && a + 1 < argc) qos = argv[++a];
    else if (!strcmp(argv[a], "--cpu") && a + 1 < argc) cpu = atoi(argv[++a]);
    else if (!strcmp(argv[a], "--pad") && a + 1 < argc) pad = atoi(argv[++a]);
    else {
      fprintf(stderr, "usage: bandwidth [--min 32K] [--max 128M] [--repeats N] [--target-ms N]\n"
                      "                 [--qos p|e|default] [--cpu N] [--pad N]\n");
      return 2;
    }
  }
  if (repeats < 1) repeats = 1;
  if (repeats > 64) repeats = 64;
  if (lo < 8 * LINE) lo = 8 * LINE;
  set_core_hint(qos, cpu);

  uint8_t *b = malloc(hi);
  if (!b) { perror("alloc"); return 1; }
  memset(b, 1, hi); // back every page now, not mid-measurement

  char mach[256]; machine_line(mach, sizeof mach);
  time_t now = time(NULL); char date[32];
  strftime(date, sizeof date, "%Y-%m-%d", localtime(&now));
  printf("# cache-covert-channel native/bandwidth.c\n# machine: %s\n# date: %s\n", mach, date);
  { char pw[384]; power_json(pw, sizeof pw); printf("# power: %s\n", pw); }
  printf("# qos: %s  repeats: %d  target_ms: %.0f  pad: %d\n", qos, repeats, target_ms, pad);
  printf("window_bytes,read_ns_per_line,rmw_ns_per_line,lines\n");

  for (size_t w = lo; w <= hi; w *= 2) {
    // warm, then size the run so it lasts ~target_ms
    walk_read(b, w, w / LINE); walk_rmw(b, w, w / LINE, pad);
    double per = walk_rmw(b, w, 200000, pad);
    uint64_t lines = (uint64_t)(target_ms * 1e6 / (per > 0.05 ? per : 0.05));
    lines = (lines + 7) & ~(uint64_t)7;
    if (lines < 200000) lines = 200000;
    double r[64], m[64];
    for (int k = 0; k < repeats; k++) { r[k] = walk_read(b, w, lines); m[k] = walk_rmw(b, w, lines, pad); }
    qsort(r, (size_t)repeats, sizeof r[0], cmp_d);
    qsort(m, (size_t)repeats, sizeof m[0], cmp_d);
    printf("%zu,%.3f,%.3f,%llu\n", w, r[(repeats - 1) / 2], m[(repeats - 1) / 2], (unsigned long long)lines);
    fflush(stdout);
  }
  free(b);
  return 0;
}

// native/channel.c — the cache covert channel between two separate PROCESSES.
//
// The browser demo runs both ends as threads of one page and agrees the start
// time out-of-band (postMessage). This version removes both shortcuts:
//
//   * sender and receiver are independent processes: separate address spaces,
//     no shared memory, no pipe or file between them;
//   * the sender starts after a random delay that only it knows, and the
//     receiver finds the frame IN-BAND: it locks onto the preamble and
//     confirms with the start-of-frame byte and checksum.
//
// What they still share: the machine (caches, memory, the OS clock's rate) and
// the protocol (chip length, frame format), as any two parties must.
//
// Frame (same as src/cache/manchester.js, without the optional FEC):
//   [16 x (1,0) raw preamble][Manchester( 0xAC | length | payload | sum mod 256 )]
//   Manchester: data 1 -> chips (1,0), data 0 -> chips (0,1).
//   chip 1 = sender streams through a large buffer, chip 0 = sender idles.
//
// Usage:
//   channel run "hello" [--trace out.json]   spawn receiver + sender, report result
//   channel recv [--seconds 5] [--trace out.json]
//   channel send "hello"
//   channel selftest                         decoder tests on synthetic traces
// Common options: --chip-ms 20 --sample-ms 1 --probe-mb 8 --buf-mb 24
//                 --qos p|e|default (macOS)  --cpu N (Linux)

#define _GNU_SOURCE
#include "common.h"
#include <math.h>
#include <spawn.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#define LINE 64
#define MB (1024ull * 1024ull)
#define PREAMBLE_PAIRS 16
#define PREAMBLE_CHIPS (PREAMBLE_PAIRS * 2)
#define SFD_BYTE 0xAC
#define MAX_PAYLOAD 255
#define MAX_CHIPS (PREAMBLE_CHIPS + (MAX_PAYLOAD + 3) * 16)

typedef struct {
  double chip_ms, sample_ms, seconds;
  int probe_mb, buf_mb, probe_steps, cpu;
  const char *qos, *trace, *send_qos, *recv_qos;
} opts_t;

static opts_t defaults(void) {
  opts_t o = { .chip_ms = 20, .sample_ms = 1, .seconds = 5, .probe_mb = 8, .buf_mb = 24,
               .probe_steps = 3000, .cpu = -1, .qos = "default", .trace = NULL,
               .send_qos = NULL, .recv_qos = NULL };
  return o;
}

static uint64_t rng_state;
static inline uint64_t rng(void) {
  rng_state ^= rng_state >> 12; rng_state ^= rng_state << 25; rng_state ^= rng_state >> 27;
  return rng_state * 0x2545F4914F6CDD1Dull;
}
static double urand(void) { return (double)(rng() >> 11) / 9007199254740992.0; }

// ------------------------------------------------------------------ framing --

static int encode_frame(const char *msg, uint8_t *chips) {
  size_t len = strlen(msg);
  if (len > MAX_PAYLOAD) len = MAX_PAYLOAD;
  uint8_t bytes[MAX_PAYLOAD + 3];
  int nb = 0, sum = 0;
  bytes[nb++] = SFD_BYTE;
  bytes[nb++] = (uint8_t)len;
  for (size_t i = 0; i < len; i++) { bytes[nb++] = (uint8_t)msg[i]; sum += (uint8_t)msg[i]; }
  bytes[nb++] = (uint8_t)(sum & 0xff);
  int n = 0;
  for (int i = 0; i < PREAMBLE_PAIRS; i++) { chips[n++] = 1; chips[n++] = 0; }
  for (int i = 0; i < nb; i++)
    for (int b = 7; b >= 0; b--) {
      int bit = (bytes[i] >> b) & 1;
      chips[n++] = bit ? 1 : 0;
      chips[n++] = bit ? 0 : 1;
    }
  return n;
}

// ------------------------------------------------------------------ decoder --
// Pure function of the sample stream: no knowledge of when the sender started.

typedef struct {
  int ok, sfd_ok, checksum_ok, length, nchips, violations;
  long start;        // sample index where the preamble begins
  double threshold;  // ns/access separating "busy" from "idle"
  int score;         // preamble match score (max PREAMBLE_CHIPS + 1)
  char text[MAX_PAYLOAD + 1];
  uint8_t chips[MAX_CHIPS];
} decode_t;

static int cmp_d(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

// Otsu's method on log(latency): the threshold that best splits the samples
// into two clusters. No calibration against known chips is needed.
static double otsu_threshold(const double *x, long n) {
  enum { B = 128 };
  double lo = 1e300, hi = -1e300;
  for (long i = 0; i < n; i++) if (x[i] > 0) { double v = log(x[i]); if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return lo > 0 ? exp(lo) : 0;
  long h[B] = {0}; long tot = 0;
  for (long i = 0; i < n; i++) if (x[i] > 0) {
    int k = (int)((log(x[i]) - lo) / (hi - lo) * (B - 1));
    h[k]++; tot++;
  }
  double sum_all = 0; for (int k = 0; k < B; k++) sum_all += k * (double)h[k];
  double best = -1, w0 = 0, sum0 = 0; int bk = B / 2;
  for (int k = 0; k < B - 1; k++) {
    w0 += h[k]; sum0 += k * (double)h[k];
    double w1 = tot - w0;
    if (w0 == 0 || w1 == 0) continue;
    double m0 = sum0 / w0, m1 = (sum_all - sum0) / w1;
    double between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best) { best = between; bk = k; }
  }
  return exp(lo + (bk + 0.5) / (B - 1) * (hi - lo));
}

// Median of the samples in the middle 60% of chip c's window. -1 = out of range.
static double chip_median(const double *x, long n, double start, int c, double spc) {
  long a = (long)(start + (c + 0.2) * spc + 0.5), b = (long)(start + (c + 0.8) * spc + 0.5);
  if (a < 0 || b > n || b <= a) return -1;
  double w[256]; int m = 0;
  for (long i = a; i < b && m < 256; i++) w[m++] = x[i];
  qsort(w, (size_t)m, sizeof w[0], cmp_d);
  return w[m / 2];
}

// Chip c thresholded: 1 = busy, 0 = idle, -1 = out of range.
static int chip_at(const double *x, long n, double start, int c, double spc, double th) {
  double v = chip_median(x, n, start, c, spc);
  return v < 0 ? -1 : v > th;
}

static int read_byte(const double *x, long n, double start, int *chip, double spc, double th,
                     uint8_t *out, decode_t *d) {
  int v = 0;
  for (int b = 0; b < 8; b++) {
    double m0 = chip_median(x, n, start, *chip, spc), m1 = chip_median(x, n, start, *chip + 1, spc);
    if (m0 < 0 || m1 < 0) return 0;
    int c0 = m0 > th, c1 = m1 > th;
    if (d->nchips + 2 <= MAX_CHIPS) { d->chips[d->nchips++] = (uint8_t)c0; d->chips[d->nchips++] = (uint8_t)c1; }
    if (c0 == c1) d->violations++;  // (0,0) / (1,1) is never a valid bit
    // Differential decision: a Manchester bit is one busy and one idle chip,
    // so compare the halves directly instead of each against the threshold.
    v = (v << 1) | (m0 > m1);
    *chip += 2;
  }
  *out = (uint8_t)v;
  return 1;
}

static void decode_at(const double *x, long n, long start, double spc, double th, decode_t *d) {
  memset(d, 0, sizeof *d);
  d->start = start; d->threshold = th;
  for (int c = 0; c < PREAMBLE_CHIPS; c++) {
    int v = chip_at(x, n, (double)start, c, spc, th);
    d->chips[d->nchips++] = (uint8_t)(v < 0 ? 0 : v);
  }
  int chip = PREAMBLE_CHIPS;
  uint8_t sfd, len, sum_got;
  if (!read_byte(x, n, (double)start, &chip, spc, th, &sfd, d)) return;
  if (!read_byte(x, n, (double)start, &chip, spc, th, &len, d)) return;
  d->sfd_ok = sfd == SFD_BYTE;
  int sum = 0;
  for (int i = 0; i < len; i++) {
    uint8_t c;
    if (!read_byte(x, n, (double)start, &chip, spc, th, &c, d)) return;
    d->text[i] = (char)c; sum += c;
  }
  if (!read_byte(x, n, (double)start, &chip, spc, th, &sum_got, d)) return;
  d->length = len;
  d->text[len] = 0;
  d->checksum_ok = (uint8_t)(sum & 0xff) == sum_got;
  d->ok = 1;
}

// Frame sync: score every sample offset against the preamble (plus one idle
// chip before it), then fully decode the best-scoring offsets and prefer one
// whose SFD and checksum check out. The alternating preamble alone is
// ambiguous by whole periods; the SFD is what resolves that.
static void decode(const double *x, long n, double spc, decode_t *best) {
  memset(best, 0, sizeof *best);
  double th = otsu_threshold(x, n);
  best->threshold = th;
  long hdr = (long)((PREAMBLE_CHIPS + 32) * spc);
  if (n <= hdr) return;
  int *score = malloc(sizeof(int) * (size_t)n);
  int maxs = -1000;
  for (long o = 0; o + hdr <= n; o++) {
    int s = 0;
    int pre = chip_at(x, n, (double)o, -1, spc, th);
    if (pre >= 0) s += pre == 0 ? 1 : -1;
    for (int c = 0; c < PREAMBLE_CHIPS; c++) {
      int v = chip_at(x, n, (double)o, c, spc, th);
      s += (v == (c % 2 == 0)) ? 1 : -1;
    }
    score[o] = s;
    if (s > maxs) maxs = s;
  }
  // Rank candidates by preamble match first, then SFD. The checksum is NOT
  // used to choose: trying many offsets and keeping whichever passes an 8-bit
  // checksum turns the checksum into a 1-in-256 lottery per try (the selftest
  // caught this as wrong-text-but-checksum-ok under heavy noise). The
  // alternating preamble is ambiguous by whole periods, which the SFD resolves;
  // among equal candidates take the middle of the tied run (furthest from
  // chip edges).
  int best_rank = -1; long first = -1, last = -1;
  decode_t d;
  for (long o = 0; o + hdr <= n; o++) {
    if (score[o] < maxs - 2) continue;
    decode_at(x, n, o, spc, th, &d);
    int rank = d.sfd_ok * 1000 + score[o] + 100;
    if (rank > best_rank) { best_rank = rank; first = last = o; }
    else if (rank == best_rank && o - last <= 1) last = o;
  }
  free(score);
  if (first >= 0) {
    decode_at(x, n, (first + last) / 2, spc, th, best);
    best->score = best_rank % 1000 - 100;
  }
}

// ------------------------------------------------------------------- sender --

static uint64_t thrash_until(volatile uint8_t *buf, size_t len, uint64_t end) {
  uint64_t acc = 0;
  for (;;) {
    for (size_t i = 0; i < len; i += LINE) {
      acc += buf[i];
      if ((i & 0x3FFFF) == 0 && now_ns() >= end) return acc;
    }
  }
}

static int do_send(const char *msg, const opts_t *o) {
  set_core_hint(o->qos, o->cpu);
  rng_state = now_ns() ^ ((uint64_t)getpid() << 32) ^ 0x9E3779B97F4A7C15ull;
  size_t len = (size_t)o->buf_mb * MB;
  volatile uint8_t *buf = malloc(len);
  if (!buf) { perror("alloc"); return 1; }
  for (size_t i = 0; i < len; i += 4096) buf[i] = 1;
  uint8_t chips[MAX_CHIPS];
  int n = encode_frame(msg, chips);
  uint64_t chip = (uint64_t)(o->chip_ms * 1e6);
  // A delay only the sender knows, so the receiver has to find the frame.
  double delay_ms = 200 + 500 * urand();
  uint64_t t0 = now_ns() + (uint64_t)(delay_ms * 1e6);
  thrash_until(buf, len, now_ns() + 30000000ull);   // ramp clocks / settle cores
  while (now_ns() < t0) {}
  uint64_t acc = 0;
  for (int k = 0; k < n; k++) {
    uint64_t end = t0 + (uint64_t)(k + 1) * chip;
    if (chips[k]) acc += thrash_until(buf, len, end);
    while (now_ns() < end) {}
  }
  fprintf(stderr, "send: %d chips (%.2f s) after a private %.0f ms delay%s\n", n,
          n * o->chip_ms / 1000.0, delay_ms, acc == 42 ? " " : "");
  return 0;
}

// ----------------------------------------------------------------- receiver --

typedef struct pnode { struct pnode *next; char pad[LINE - sizeof(void *)]; } pnode;

static void json_str(FILE *f, const char *s) {
  fputc('"', f);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(f, "\\%c", *p);
    else if (*p < 0x20 || *p >= 0x7f) fprintf(f, "\\u%04x", *p);
    else fputc(*p, f);
  }
  fputc('"', f);
}

static void write_trace(const char *path, const opts_t *o, const double *x, long n, const decode_t *d) {
  FILE *f = fopen(path, "w");
  if (!f) { perror(path); return; }
  char mach[256]; machine_line(mach, sizeof mach);
  time_t now = time(NULL); char date[40];
  strftime(date, sizeof date, "%Y-%m-%dT%H:%M:%S%z", localtime(&now));
  fprintf(f, "{\n  \"format\": \"cache-covert-channel/trace@1\",\n  \"source\": \"native-cross-process\",\n");
  fprintf(f, "  \"machine\": "); json_str(f, mach);
  fprintf(f, ",\n  \"captured\": \"%s\",\n", date);
  { char pw[384]; power_json(pw, sizeof pw); fprintf(f, "  \"power\": %s,\n", pw); }
  fprintf(f, "  \"params\": { \"chip_ms\": %g, \"sample_ms\": %g, \"probe_mb\": %d, \"probe_steps\": %d, \"sender_buf_mb\": %d, \"qos\": ",
          o->chip_ms, o->sample_ms, o->probe_mb, o->probe_steps, o->buf_mb);
  json_str(f, o->qos);
  fprintf(f, " },\n  \"sync\": \"in-band: preamble correlation + SFD; no shared start time\",\n");
  fprintf(f, "  \"decoded\": { \"ok\": %s, \"text\": ", d->ok ? "true" : "false");
  json_str(f, d->ok ? d->text : "");
  fprintf(f, ", \"sfd_ok\": %s, \"checksum_ok\": %s, \"length\": %d, \"manchester_violations\": %d, \"frame_start_sample\": %ld, \"threshold_ns\": %.3f, \"preamble_score\": %d },\n",
          d->sfd_ok ? "true" : "false", d->checksum_ok ? "true" : "false", d->length, d->violations,
          d->start, d->threshold, d->score);
  fprintf(f, "  \"chips\": [");
  for (int i = 0; i < d->nchips; i++) fprintf(f, "%s%d", i ? "," : "", d->chips[i]);
  fprintf(f, "],\n  \"samples_ns_per_access\": [");
  for (long i = 0; i < n; i++) fprintf(f, "%s%.2f", i ? "," : "", x[i]);
  fprintf(f, "]\n}\n");
  fclose(f);
}

static int do_recv(const opts_t *o) {
  set_core_hint(o->qos, o->cpu);
  rng_state = 0x1234567ull;
  size_t nl = (size_t)o->probe_mb * MB / LINE;
  pnode *buf = NULL;
  if (posix_memalign((void **)&buf, 16384, nl * sizeof(pnode))) { perror("alloc"); return 1; }
  uint32_t *perm = malloc(nl * sizeof *perm);
  for (size_t i = 0; i < nl; i++) perm[i] = (uint32_t)i;
  for (size_t i = nl - 1; i > 0; i--) { size_t j = rng() % (i + 1); uint32_t t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (size_t i = 0; i < nl; i++) buf[perm[i]].next = &buf[perm[(i + 1) % nl]];
  free(perm);
  pnode *p = buf;
  for (size_t i = 0; i < nl * 2; i++) p = p->next; // warm: region resident

  uint64_t ts = (uint64_t)(o->sample_ms * 1e6);
  long n = (long)(o->seconds * 1e3 / o->sample_ms);
  double *x = malloc(sizeof(double) * (size_t)n);
  uint64_t t0 = now_ns();
  for (long k = 0; k < n; k++) {
    while (now_ns() < t0 + (uint64_t)k * ts) {}
    uint64_t a = now_ns();
    for (int s = 0; s < o->probe_steps; s++) p = p->next;
    x[k] = (double)(now_ns() - a) / o->probe_steps;
  }
  if (p == NULL) return 3; // keep the chain live

  decode_t d;
  decode(x, n, o->chip_ms / o->sample_ms, &d);
  fprintf(stderr, "recv: %ld samples, threshold %.1f ns, frame at %.0f ms, sfd %s, checksum %s, text \"%s\"\n",
          n, d.threshold, d.start * o->sample_ms, d.sfd_ok ? "ok" : "BAD",
          d.checksum_ok ? "ok" : "BAD", d.ok ? d.text : "");
  if (o->trace) write_trace(o->trace, o, x, n, &d);
  free(x); free(buf);
  return d.ok && d.checksum_ok ? 0 : 1;
}

// ---------------------------------------------------------------------- run --
// Launch receiver and sender as two separate processes (posix_spawn of this
// binary). The parent knows the message only to compare at the end.

static int count_bit_errors(const char *a, const char *b, int *bits) {
  size_t la = strlen(a), lb = strlen(b), n = la > lb ? la : lb;
  int e = 0;
  for (size_t i = 0; i < n; i++) {
    if (i >= la || i >= lb) { e += 8; continue; } // missing or extra byte: all 8 bits wrong
    e += __builtin_popcount((unsigned)((unsigned char)a[i] ^ (unsigned char)b[i]));
  }
  *bits = (int)n * 8;
  return e;
}

static int do_run(const char *self, const char *msg, const opts_t *o, char **pass, int npass) {
  char trace_tmp[] = "/tmp/ccc-trace-XXXXXX";
  const char *trace = o->trace;
  if (!trace) { int fd = mkstemp(trace_tmp); if (fd >= 0) close(fd); trace = trace_tmp; }
  char *rargv[64], *sargv[64]; int ra = 0, sa = 0;
  rargv[ra++] = (char *)self; rargv[ra++] = "recv"; rargv[ra++] = "--trace"; rargv[ra++] = (char *)trace;
  sargv[sa++] = (char *)self; sargv[sa++] = "send"; sargv[sa++] = (char *)msg;
  for (int i = 0; i < npass && ra < 58; i++) { rargv[ra++] = pass[i]; sargv[sa++] = pass[i]; }
  if (o->recv_qos) { rargv[ra++] = "--qos"; rargv[ra++] = (char *)o->recv_qos; }
  if (o->send_qos) { sargv[sa++] = "--qos"; sargv[sa++] = (char *)o->send_qos; }
  rargv[ra] = NULL; sargv[sa] = NULL;
  pid_t rp, sp;
  if (posix_spawn(&rp, self, NULL, NULL, rargv, environ)) { perror("spawn recv"); return 1; }
  usleep(50000);
  if (posix_spawn(&sp, self, NULL, NULL, sargv, environ)) { perror("spawn send"); return 1; }
  int st; waitpid(sp, &st, 0); waitpid(rp, &st, 0);

  // Read the decoded text back out of the receiver's trace.
  FILE *f = fopen(trace, "r");
  char got[1024] = ""; int checksum_ok = 0;
  if (f) {
    char line[1 << 16];
    while (fgets(line, sizeof line, f)) {
      char *t = strstr(line, "\"decoded\"");
      if (!t) continue;
      checksum_ok = strstr(line, "\"checksum_ok\": true") != NULL;
      char *q = strstr(t, "\"text\": \"");
      if (q) {
        q += 9; size_t k = 0;
        while (*q && *q != '"' && k < sizeof got - 1) {
          if (q[0] == '\\' && q[1] == 'u') { got[k++] = (char)strtol((char[]){q[4], q[5], 0}, NULL, 16); q += 6; }
          else if (q[0] == '\\' && q[1]) { got[k++] = q[1]; q += 2; }
          else got[k++] = *q++;
        }
        got[k] = 0;
      }
    }
    fclose(f);
  }
  int bits, errs = count_bit_errors(msg, got, &bits);
  // Append ground truth to the trace for the record.
  if (o->trace) {
    FILE *g = fopen(trace, "r+");
    if (g) {
      fseek(g, -2, SEEK_END); // overwrite the final "}\n"
      fprintf(g, ",\n  \"sent\": "); json_str(g, msg);
      fprintf(g, ",\n  \"payload_bit_errors\": %d,\n  \"payload_bits\": %d\n}\n", errs, bits);
      fclose(g);
    }
  } else unlink(trace_tmp);
  printf("sent \"%s\"  received \"%s\"  checksum %s  payload bit errors %d/%d\n",
         msg, got, checksum_ok ? "ok" : "FAIL", errs, bits);
  return errs == 0 && checksum_ok ? 0 : 1;
}

// ----------------------------------------------------------------- selftest --
// Synthetic traces: idle lead-in of unknown length, frame at a random sub-chip
// phase, log-normal noise and occasional spikes. Checks that frame sync and
// decoding recover the message, and that a frame cut short is not reported ok.

static long synth(const char *msg, double *x, long cap, double spc, double sigma, long *start_out) {
  uint8_t chips[MAX_CHIPS];
  int nc = encode_frame(msg, chips);
  long lead = 50 + (long)(urand() * 600);
  double phase = urand() * spc;
  long n = lead + (long)(nc * spc + phase) + 200;
  if (n > cap) n = cap;
  for (long i = 0; i < n; i++) {
    double t = (double)(i - lead) - phase;
    int c = t >= 0 ? (int)(t / spc) : -1;
    int busy = c >= 0 && c < nc && chips[c];
    double base = busy ? 90.0 : 8.7;
    double g = sqrt(-2 * log(urand() + 1e-12)) * cos(2 * M_PI * urand());
    x[i] = base * exp(sigma * g);
    if (urand() < 0.01) x[i] *= 6; // scheduler hiccup
  }
  *start_out = lead;
  return n;
}

static int do_selftest(void) {
  const char *msgs[] = { "cache", "Hi", "the quick brown fox", "0123456789abcdef" };
  enum { CAP = 20000 };
  static double x[CAP];
  int fails = 0, trials = 0;
  rng_state = 42;
  for (int m = 0; m < 4; m++)
    for (int s = 0; s < 50; s++) {
      double spc = (s % 2) ? 10.0 : 7.5; // integer and fractional samples-per-chip
      long st;
      long n = synth(msgs[m], x, CAP, spc, 0.25, &st);
      decode_t d; decode(x, n, spc, &d);
      trials++;
      if (!(d.ok && d.checksum_ok && d.sfd_ok && !strcmp(d.text, msgs[m]))) {
        fails++;
        fprintf(stderr, "FAIL clean decode: msg \"%s\" spc %.1f got \"%s\" (start %ld vs %ld)\n",
                msgs[m], spc, d.text, d.start, st);
      }
    }
  // Truncated: cut the recording mid-frame; must not claim a good checksum
  // for the wrong text.
  for (int s = 0; s < 20; s++) {
    long st; long n = synth("truncated message", x, CAP, 10.0, 0.25, &st);
    decode_t d; decode(x, n - 600, 10.0, &d);
    trials++;
    if (d.ok && d.checksum_ok && strcmp(d.text, "truncated message")) { fails++; fprintf(stderr, "FAIL truncated accepted\n"); }
  }
  // Heavy noise: errors are allowed, silently-wrong "checksum ok" is counted.
  int wrong_but_ok = 0, heavy = 0;
  for (int s = 0; s < 50; s++) {
    long st; long n = synth("cache", x, CAP, 10.0, 1.2, &st);
    decode_t d; decode(x, n, 10.0, &d);
    heavy++;
    if (d.ok && d.checksum_ok && strcmp(d.text, "cache")) wrong_but_ok++;
  }
  printf("selftest: %d/%d decode checks passed; heavy-noise runs with a wrong text but passing checksum: %d/%d\n",
         trials - fails, trials, wrong_but_ok, heavy);
  return fails ? 1 : 0;
}

// --------------------------------------------------------------------- main --

static void usage(void) {
  fprintf(stderr,
    "usage: channel run <msg> | send <msg> | recv | selftest\n"
    "       [--chip-ms 20] [--sample-ms 1] [--seconds 5] [--probe-mb 8] [--buf-mb 24]\n"
    "       [--probe-steps 3000] [--qos p|e|default] [--cpu N] [--trace out.json]\n"
    "       run only: [--send-qos p|e] [--recv-qos p|e]  (overrides --qos per end)\n");
}

int main(int argc, char **argv) {
  if (argc < 2) { usage(); return 2; }
  const char *cmd = argv[1], *msg = NULL;
  int i = 2;
  if ((!strcmp(cmd, "run") || !strcmp(cmd, "send")) && argc > 2) msg = argv[i++];
  opts_t o = defaults();
  char *pass[64]; int npass = 0; // options forwarded to children by `run`
  for (; i < argc; i++) {
    const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!v) { usage(); return 2; }
    if (!strcmp(a, "--trace")) { o.trace = v; i++; continue; }
    if (!strcmp(a, "--send-qos")) { o.send_qos = v; i++; continue; }
    if (!strcmp(a, "--recv-qos")) { o.recv_qos = v; i++; continue; }
    if (!strcmp(a, "--chip-ms")) o.chip_ms = atof(v);
    else if (!strcmp(a, "--sample-ms")) o.sample_ms = atof(v);
    else if (!strcmp(a, "--seconds")) o.seconds = atof(v);
    else if (!strcmp(a, "--probe-mb")) o.probe_mb = atoi(v);
    else if (!strcmp(a, "--buf-mb")) o.buf_mb = atoi(v);
    else if (!strcmp(a, "--probe-steps")) o.probe_steps = atoi(v);
    else if (!strcmp(a, "--qos")) o.qos = v;
    else if (!strcmp(a, "--cpu")) o.cpu = atoi(v);
    else { usage(); return 2; }
    if (npass < 62) { pass[npass++] = argv[i]; pass[npass++] = argv[i + 1]; }
    i++;
  }
  if (!strcmp(cmd, "selftest")) return do_selftest();
  if (!strcmp(cmd, "recv")) return do_recv(&o);
  if (!strcmp(cmd, "send") && msg) return do_send(msg, &o);
  if (!strcmp(cmd, "run") && msg) {
    if (strlen(msg) > 64) { fprintf(stderr, "keep messages short (<= 64 chars)\n"); return 2; }
    // make sure the receiver records long enough for this frame + the sender's delay
    double need = (PREAMBLE_CHIPS + (strlen(msg) + 3) * 16) * o.chip_ms / 1000.0 + 1.2;
    if (o.seconds < need) {
      o.seconds = need;
      static char sec[32]; snprintf(sec, sizeof sec, "%.2f", need);
      pass[npass++] = "--seconds"; pass[npass++] = sec;
    }
    return do_run(argv[0], msg, &o, pass, npass);
  }
  usage();
  return 2;
}

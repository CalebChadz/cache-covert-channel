// native/common.h — clock, core-cluster hint and machine description shared
// by chase.c and channel.c.
#ifndef CCC_COMMON_H
#define CCC_COMMON_H

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/utsname.h>

#ifdef __APPLE__
#include <pthread.h>
#include <pthread/qos.h>
#include <sys/sysctl.h>
// Monotonic nanosecond clock that doesn't advance while asleep.
static inline uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }
#else
#include <sched.h>
static inline uint64_t now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000000000ull + (uint64_t)t.tv_nsec;
}
#endif

// macOS can't pin threads to cores, but QoS steers the scheduler:
// "p" -> performance cluster, "e" -> efficiency cluster. Linux: pin to `cpu`.
static inline void set_core_hint(const char *qos, int cpu) {
#ifdef __APPLE__
  if (qos && !strcmp(qos, "p")) pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  else if (qos && !strcmp(qos, "e")) pthread_set_qos_class_self_np(QOS_CLASS_BACKGROUND, 0);
  (void)cpu;
#else
  (void)qos;
  if (cpu >= 0) {
    cpu_set_t set; CPU_ZERO(&set); CPU_SET(cpu, &set);
    if (sched_setaffinity(0, sizeof set, &set)) perror("sched_setaffinity");
  }
#endif
}

static inline void machine_line(char *out, size_t len) {
  struct utsname u; uname(&u);
#ifdef __APPLE__
  char cpu[128] = "?"; size_t sz = sizeof cpu;
  sysctlbyname("machdep.cpu.brand_string", cpu, &sz, NULL, 0);
  snprintf(out, len, "%s, %s %s", cpu, u.sysname, u.release);
#else
  snprintf(out, len, "%s %s %s", u.machine, u.sysname, u.release);
#endif
}

// Power state as a JSON object, for traces: are we on mains or battery?
// macOS: parsed from `pmset -g batt`. Linux: /sys/class/power_supply.
// Anything unreadable is reported as unavailable rather than guessed.
#include <stdlib.h>
static inline void power_json(char *out, size_t len) {
  snprintf(out, len, "{ \"available\": false }");
#ifdef __APPLE__
  FILE *f = popen("pmset -g batt 2>/dev/null", "r");
  if (!f) return;
  char line[256], src[64] = "", status[64] = ""; int pct = -1;
  while (fgets(line, sizeof line, f)) {
    char *q = strstr(line, "drawing from '");
    if (q) { q += 14; size_t k = 0; while (*q && *q != '\'' && k < sizeof src - 1) src[k++] = *q++; src[k] = 0; }
    char *pc = strchr(line, '%');
    if (pc && pct < 0) {
      char *b = pc; while (b > line && b[-1] >= '0' && b[-1] <= '9') b--;
      pct = atoi(b);
      char *sc = strchr(pc, ';');
      if (sc) { sc++; while (*sc == ' ') sc++; size_t k = 0; while (*sc && *sc != ';' && *sc != '\n' && k < sizeof status - 1) status[k++] = *sc++; status[k] = 0; }
    }
  }
  pclose(f);
  if (!src[0]) return;
  snprintf(out, len, "{ \"available\": true, \"source\": \"pmset\", \"power_source\": \"%s\", \"charging\": %s, \"level\": %.2f, \"status\": \"%s\" }",
           src, !strcmp(status, "charging") ? "true" : "false",
           pct >= 0 ? pct / 100.0 : -1.0, status);
#else
  int ac = -1, cap = -1; char st[32] = "";
  FILE *f;
  const char *acs[] = { "/sys/class/power_supply/AC/online", "/sys/class/power_supply/ACAD/online", "/sys/class/power_supply/ADP1/online" };
  for (int i = 0; i < 3 && ac < 0; i++) if ((f = fopen(acs[i], "r"))) { if (fscanf(f, "%d", &ac) != 1) ac = -1; fclose(f); }
  if ((f = fopen("/sys/class/power_supply/BAT0/capacity", "r"))) { if (fscanf(f, "%d", &cap) != 1) cap = -1; fclose(f); }
  if ((f = fopen("/sys/class/power_supply/BAT0/status", "r"))) { if (fscanf(f, "%31s", st) != 1) st[0] = 0; fclose(f); }
  if (ac < 0 && cap < 0) return; // desktop/VM: no power supply info
  snprintf(out, len, "{ \"available\": true, \"source\": \"sysfs\", \"power_source\": \"%s\", \"charging\": %s, \"level\": %.2f, \"status\": \"%s\" }",
           ac == 1 ? "AC Power" : (ac == 0 ? "Battery Power" : "unknown"),
           !strcmp(st, "Charging") ? "true" : "false", cap >= 0 ? cap / 100.0 : -1.0, st);
#endif
}

#endif

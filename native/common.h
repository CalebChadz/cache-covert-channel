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

#endif

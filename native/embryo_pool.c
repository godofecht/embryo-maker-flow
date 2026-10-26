// Persistent worker pool for the deterministic parallel passes in
// src/workers.flow. Flow's own `parallel for` creates and joins a thread per
// call, which costs more than a 1,000 node force pass; this pool keeps its
// threads, hands out index ranges through one atomic counter, and lets the
// calling thread work as thread 0. Workers spin briefly for the next job and
// then park on a condition variable, so an idle UI server burns nothing.
//
// Jobs call back into Flow through embryo_parallel_entry(kind, start, end,
// thread), defined in src/workers.flow. Each call owns [start, end) and
// writes only per-node state in that range or per-thread scratch, which is
// what keeps the result identical to the serial code.
#if defined(__linux__)
#define _GNU_SOURCE
#endif
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <time.h>
#include <limits.h>
#if defined(__APPLE__)
#include <sys/sysctl.h>
#include <pthread/qos.h>
#elif defined(__linux__)
#include <sched.h>
#else
#include <unistd.h>
#endif
#if defined(__APPLE__) || defined(__linux__)
#include <unistd.h>
#endif

/* The Flow entry (embryo_parallel_entry in src/workers.flow) is registered
   at run time through embryo_pool_set_entry, so programs without that
   module still link; the pool then reports one thread and every pass stays
   serial. */
typedef void (*embryo_entry_fn)(int32_t kind, int32_t start, int32_t end, int32_t thread);
static embryo_entry_fn g_entry = NULL;

void embryo_pool_set_entry(void *fn) {
    g_entry = (embryo_entry_fn)fn;
}

#define EMBRYO_POOL_MAX_THREADS 64

static pthread_t g_threads[EMBRYO_POOL_MAX_THREADS];
static int32_t g_thread_count = 0;          /* including the calling thread */
static int g_started = 0;
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_wake = PTHREAD_COND_INITIALIZER;
static _Atomic uint64_t g_generation = 0;   /* bumps once per job */
static _Atomic int32_t g_next = 0;          /* next chunk start */
static _Atomic int32_t g_pending = 0;       /* threads still working on the job */
static int32_t g_kind = 0, g_count = 0, g_grain = 1;
static _Atomic int g_shutdown = 0;
static _Atomic int g_parked = 0;            /* workers waiting on the condvar */
/* Spins before a worker parks. Passes arrive a few hundred microseconds
   apart inside one iteration, and a parked thread adds about 20 us of wake
   latency to the next fork, so the default spin covers a few milliseconds.
   EMBRYO_POOL_SPINS overrides it. */
static long g_spin_limit = 400000;
/* EMBRYO_PARALLEL_STATS=1: wall time per job kind, printed at exit. */
static int g_stats = 0;
static double g_stat_time[16];
static long g_stat_calls[16];
static double now_seconds(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}
static void print_stats(void) {
    fprintf(stderr, "embryo_pool: %d thread(s)\n", g_thread_count);
    static const char *names[] = {"", "neighbor_scan", "gene_step", "force_pairs", "force_reduce", "force_active_genes", "", "", "", "", "", "", "", "", "", ""};
    for (int k = 1; k < 16; k++) {
        if (g_stat_calls[k] == 0) continue;
        fprintf(stderr, "  kind %d %-18s %8ld calls %10.3f ms total %8.1f us/call\n", k, names[k], g_stat_calls[k], g_stat_time[k] * 1e3, g_stat_time[k] * 1e6 / (double)g_stat_calls[k]);
    }
}

static int32_t linux_quota_limit(const char *cgroup_path) {
    char path[512];
    char quota_text[32];
    long long period = 0;

    snprintf(path, sizeof(path), "/sys/fs/cgroup%s/cpu.max", cgroup_path);
    FILE *file = fopen(path, "r");
    if (file) {
        int fields = fscanf(file, "%31s %lld", quota_text, &period);
        fclose(file);
        if (fields == 2 && strcmp(quota_text, "max") != 0 && period > 0) {
            long long quota = atoll(quota_text);
            if (quota > 0) {
                long long cpus = (quota + period - 1) / period;
                return cpus > INT_MAX ? INT_MAX : (int32_t)(cpus > 0 ? cpus : 1);
            }
        }
        if (fields == 2 && strcmp(quota_text, "max") == 0) return 0;
    }

    const char *mounts[] = { "/sys/fs/cgroup/cpu%s/cpu.cfs_quota_us",
                             "/sys/fs/cgroup/cpu,cpuacct%s/cpu.cfs_quota_us" };
    const char *periods[] = { "/sys/fs/cgroup/cpu%s/cpu.cfs_period_us",
                              "/sys/fs/cgroup/cpu,cpuacct%s/cpu.cfs_period_us" };
    for (int i = 0; i < 2; i++) {
        long long quota = -1;
        period = 0;
        snprintf(path, sizeof(path), mounts[i], cgroup_path);
        file = fopen(path, "r");
        if (file) {
            int fields = fscanf(file, "%lld", &quota);
            if (fields != 1) quota = -1;
            fclose(file);
        }
        snprintf(path, sizeof(path), periods[i], cgroup_path);
        file = fopen(path, "r");
        if (file) {
            int fields = fscanf(file, "%lld", &period);
            if (fields != 1) period = 0;
            fclose(file);
        }
        if (quota > 0 && period > 0) {
            long long cpus = (quota + period - 1) / period;
            return cpus > INT_MAX ? INT_MAX : (int32_t)(cpus > 0 ? cpus : 1);
        }
    }
    return 0;
}

static int has_cpu_controller(const char *controllers) {
    const char *start = controllers;
    while (*start) {
        const char *end = strchr(start, ',');
        size_t length = end ? (size_t)(end - start) : strlen(start);
        if ((length == 3 && strncmp(start, "cpu", length) == 0) ||
            (length == 7 && strncmp(start, "cpuacct", length) == 0)) return 1;
        if (!end) break;
        start = end + 1;
    }
    return 0;
}

static int32_t linux_cpu_limit(void) {
    char line[512];
    char cgroup_path[256];
    FILE *file = fopen("/proc/self/cgroup", "r");
    if (!file) return linux_quota_limit("");

    while (fgets(line, sizeof(line), file)) {
        if (strncmp(line, "0::", 3) == 0) {
            size_t length = strcspn(line + 3, "\r\n");
            if (length >= sizeof(cgroup_path)) continue;
            memcpy(cgroup_path, line + 3, length);
            cgroup_path[length] = '\0';
            fclose(file);
            return linux_quota_limit(cgroup_path);
        }

        char controllers[256];
        if (sscanf(line, "%*d:%255[^:]:%255s", controllers, cgroup_path) == 2 &&
            has_cpu_controller(controllers)) {
            fclose(file);
            return linux_quota_limit(cgroup_path);
        }
    }
    fclose(file);
    return linux_quota_limit("");
}

static int32_t default_threads(void) {
    long count = 0;
#if defined(__APPLE__)
    int32_t apple_count = 0;
    size_t size = sizeof(apple_count);
    if (sysctlbyname("hw.perflevel0.logicalcpu", &apple_count, &size, NULL, 0) != 0 || apple_count <= 0) {
        size = sizeof(apple_count);
        if (sysctlbyname("hw.logicalcpu", &apple_count, &size, NULL, 0) != 0) apple_count = 0;
    }
    count = apple_count;
#elif defined(__linux__)
    cpu_set_t allowed;
    CPU_ZERO(&allowed);
    if (sched_getaffinity(0, sizeof(allowed), &allowed) == 0) count = CPU_COUNT(&allowed);
    if (count <= 0) count = sysconf(_SC_NPROCESSORS_ONLN);
    int32_t quota = linux_cpu_limit();
    if (quota > 0 && (count <= 0 || quota < count)) count = quota;
#else
    count = sysconf(_SC_NPROCESSORS_ONLN);
#endif
    int32_t n = count > 0 ? (int32_t)(count > INT_MAX ? INT_MAX : count) : 0;
    if (n <= 0) n = 1;
    /* Leave two cores for the rest of the machine on larger hosts. */
    if (n > 4) n -= 2;
    return n;
}

static void run_chunks(int32_t thread) {
    for (;;) {
        int32_t start = atomic_fetch_add_explicit(&g_next, g_grain, memory_order_relaxed);
        if (start >= g_count) break;
        int32_t end = start + g_grain;
        if (end > g_count) end = g_count;
        g_entry(g_kind, start, end, thread);
    }
}

static void *worker_main(void *arg) {
    int32_t thread = (int32_t)(intptr_t)arg;
#if defined(__APPLE__)
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#endif
    uint64_t seen = 0;
    for (;;) {
        /* Spin for a short while: jobs arrive in bursts during an iteration. */
        uint64_t generation = atomic_load_explicit(&g_generation, memory_order_acquire);
        if (generation == seen) {
            long spins = 0;
            while ((generation = atomic_load_explicit(&g_generation, memory_order_acquire)) == seen &&
                   !atomic_load_explicit(&g_shutdown, memory_order_relaxed)) {
                if (++spins < g_spin_limit) {
#if defined(__aarch64__)
                    __asm__ __volatile__("yield");
#elif defined(__x86_64__) || defined(__i386__)
                    __asm__ __volatile__("pause" ::: "memory");
#endif
                    continue;
                }
                pthread_mutex_lock(&g_lock);
                atomic_fetch_add_explicit(&g_parked, 1, memory_order_acq_rel);
                while (atomic_load_explicit(&g_generation, memory_order_acquire) == seen &&
                       !atomic_load_explicit(&g_shutdown, memory_order_relaxed)) {
                    pthread_cond_wait(&g_wake, &g_lock);
                }
                atomic_fetch_sub_explicit(&g_parked, 1, memory_order_acq_rel);
                pthread_mutex_unlock(&g_lock);
                generation = atomic_load_explicit(&g_generation, memory_order_acquire);
                break;
            }
        }
        if (atomic_load_explicit(&g_shutdown, memory_order_relaxed)) return NULL;
        seen = generation;
        run_chunks(thread);
        atomic_fetch_sub_explicit(&g_pending, 1, memory_order_acq_rel);
    }
}

int32_t embryo_pool_start(int32_t requested) {
    if (g_started) return g_thread_count;
    if (!g_entry) { g_started = 1; g_thread_count = 1; return 1; }
    int32_t threads = requested > 0 ? requested : default_threads();
    const char *stats = getenv("EMBRYO_PARALLEL_STATS");
    if (stats && stats[0] == '1') { g_stats = 1; atexit(print_stats); }
    const char *spin_setting = getenv("EMBRYO_POOL_SPINS");
    if (spin_setting && *spin_setting) { long v = atol(spin_setting); if (v > 0) g_spin_limit = v; }
    if (threads > EMBRYO_POOL_MAX_THREADS) threads = EMBRYO_POOL_MAX_THREADS;
    g_thread_count = 1;
    for (int32_t t = 1; t < threads; t++) {
        if (pthread_create(&g_threads[t], NULL, worker_main, (void *)(intptr_t)t) != 0) break;
        g_thread_count = t + 1;
    }
    g_started = 1;
    return g_thread_count;
}

int32_t embryo_pool_threads(void) {
    return g_started ? g_thread_count : 0;
}

/* Runs embryo_parallel_entry(kind, ...) over [0, count) in chunks of grain
   indices. Returns after every chunk has finished. */
static void pool_run_inner(int32_t kind, int32_t count, int32_t grain);

void embryo_pool_run(int32_t kind, int32_t count, int32_t grain) {
    if (count <= 0) return;
    if (grain < 1) grain = 1;
    if (!g_stats) { pool_run_inner(kind, count, grain); return; }
    double t0 = now_seconds();
    pool_run_inner(kind, count, grain);
    if (kind >= 0 && kind < 16) { g_stat_time[kind] += now_seconds() - t0; g_stat_calls[kind]++; }
}

static void pool_run_inner(int32_t kind, int32_t count, int32_t grain) {
    if (!g_started || g_thread_count <= 1) {
        if (g_entry) g_entry(kind, 0, count, 0);
        return;
    }
    g_kind = kind;
    g_count = count;
    g_grain = grain;
    atomic_store_explicit(&g_next, 0, memory_order_relaxed);
    atomic_store_explicit(&g_pending, g_thread_count - 1, memory_order_relaxed);
    /* Spinning workers see the generation change without a syscall; the
       broadcast is only needed for parked ones. The lock orders the parked
       count against a worker that is about to wait. */
    if (atomic_load_explicit(&g_parked, memory_order_acquire) > 0) {
        pthread_mutex_lock(&g_lock);
        atomic_fetch_add_explicit(&g_generation, 1, memory_order_acq_rel);
        pthread_cond_broadcast(&g_wake);
        pthread_mutex_unlock(&g_lock);
    } else {
        pthread_mutex_lock(&g_lock);
        atomic_fetch_add_explicit(&g_generation, 1, memory_order_acq_rel);
        if (atomic_load_explicit(&g_parked, memory_order_acquire) > 0) pthread_cond_broadcast(&g_wake);
        pthread_mutex_unlock(&g_lock);
    }
    run_chunks(0);
    while (atomic_load_explicit(&g_pending, memory_order_acquire) > 0) {
#if defined(__aarch64__)
        __asm__ __volatile__("yield");
#endif
    }
}

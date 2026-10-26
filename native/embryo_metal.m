// Metal host for the GPU neighbor prefilter. Compiled through the [native]
// table in flow.toml. The kernel source comes from
// native/embryo_metal_kernels.h, which tools/build-gpu.sh regenerates from
// gpu/kernels/neighbor_prefilter.flow. Everything persists across calls: the
// device, the pipeline state, and shared-storage buffers that grow on demand,
// so a call costs one command buffer plus the copies in and out.
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>

#if defined(__APPLE__)
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include <mach-o/dyld.h>
#include "embryo_metal_kernels.h"
#include "embryo_metal_softdouble.h"
#include "embryo_metal_force.h"

static id<MTLDevice> g_device = nil;
static id<MTLCommandQueue> g_queue = nil;
static id<MTLComputePipelineState> g_prefilter = nil;
static int g_state = 0; /* 0 untried, 1 ready, -1 unavailable */

enum { BUF_PX, BUF_PY, BUF_PZ, BUF_RADIUS, BUF_BOX_START, BUF_BOX_NODES, BUF_NODE_BOX, BUF_OUT_COUNT, BUF_OUT_IDS, BUF_COUNT };
static id<MTLBuffer> g_buffers[BUF_COUNT];
static int64_t g_capacity[BUF_COUNT];

/* Offline libraries and GPU archives avoid both source and driver compilation.
   An explicit directory is strict: missing or incompatible assets fail. */
static NSString *offline_directory(void) {
    const char *override = getenv("EMBRYO_METAL_LIBRARY_DIR");
    if (override && *override) return [NSString stringWithUTF8String:override];
    uint32_t size = 0;
    _NSGetExecutablePath(NULL, &size);
    char *path = malloc(size);
    if (!path) return nil;
    NSString *directory = nil;
    if (_NSGetExecutablePath(path, &size) == 0) {
        directory = [[[NSString stringWithUTF8String:path] stringByDeletingLastPathComponent]
            stringByAppendingPathComponent:@"embryomaker-metal"];
    }
    free(path);
    return directory && [[NSFileManager defaultManager] fileExistsAtPath:directory] ? directory : nil;
}

static id<MTLLibrary> load_library(NSString *name, const char *source, NSError **error) {
    NSString *directory = offline_directory();
    if (directory) {
        NSURL *url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:[name stringByAppendingString:@".metallib"]]];
        return [g_device newLibraryWithURL:url error:error];
    }
    MTLCompileOptions *options = [[MTLCompileOptions alloc] init];
    options.fastMathEnabled = NO;
    return [g_device newLibraryWithSource:[NSString stringWithUTF8String:source] options:options error:error];
}

static id<MTLComputePipelineState> load_pipeline(id<MTLFunction> function, NSString *name, NSError **error) {
    if (!function) return nil;
    NSString *directory = offline_directory();
    if (!directory) return [g_device newComputePipelineStateWithFunction:function error:error];
    MTLBinaryArchiveDescriptor *archiveDescriptor = [MTLBinaryArchiveDescriptor new];
    archiveDescriptor.url = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:[name stringByAppendingString:@".archive"]]];
    id<MTLBinaryArchive> archive = [g_device newBinaryArchiveWithDescriptor:archiveDescriptor error:error];
    if (!archive) return nil;
    MTLComputePipelineDescriptor *descriptor = [MTLComputePipelineDescriptor new];
    descriptor.computeFunction = function;
    descriptor.binaryArchives = @[archive];
    return [g_device newComputePipelineStateWithDescriptor:descriptor
        options:MTLPipelineOptionFailOnBinaryArchiveMiss reflection:nil error:error];
}

static int embryo_metal_init(void) {
    if (g_state != 0) return g_state;
    @autoreleasepool {
        g_device = MTLCreateSystemDefaultDevice();
        if (!g_device) { g_state = -1; return g_state; }
        NSError *error = nil;
        id<MTLLibrary> library = load_library(@"neighbor_prefilter", embryo_metal_neighbor_prefilter_source, &error);
        if (!library) { NSLog(@"embryo_metal: kernel compile failed: %@", error); g_state = -1; return g_state; }
        id<MTLFunction> fn = [library newFunctionWithName:@"neighbor_prefilter"];
        if (!fn) { g_state = -1; return g_state; }
        g_prefilter = load_pipeline(fn, @"neighbor_prefilter", &error);
        if (!g_prefilter) { NSLog(@"embryo_metal: pipeline failed: %@", error); g_state = -1; return g_state; }
        g_queue = [g_device newCommandQueue];
        g_state = g_queue ? 1 : -1;
        return g_state;
    }
}

static id<MTLBuffer> embryo_metal_buffer(int slot, int64_t bytes) {
    if (bytes < 16) bytes = 16;
    if (g_buffers[slot] == nil || g_capacity[slot] < bytes) {
        int64_t capacity = g_capacity[slot] * 2;
        if (capacity < bytes) capacity = bytes;
        g_buffers[slot] = [g_device newBufferWithLength:(NSUInteger)capacity options:MTLResourceStorageModeShared];
        g_capacity[slot] = g_buffers[slot] ? capacity : 0;
    }
    return g_buffers[slot];
}

static int embryo_metal_upload(int slot, const void *src, int64_t bytes) {
    id<MTLBuffer> buffer = embryo_metal_buffer(slot, bytes);
    if (!buffer) return 0;
    memcpy([buffer contents], src, (size_t)bytes);
    return 1;
}

int32_t embryo_gpu_available(void) {
    return embryo_metal_init() == 1 ? 1 : 0;
}

const char *embryo_gpu_device_name(void) {
    if (embryo_metal_init() != 1) return "";
    return [[g_device name] UTF8String];
}

/* Returns 0 on success, 1 when Metal is unavailable, 2 on a buffer failure. */
int32_t embryo_gpu_neighbor_prefilter(const float *px, const float *py, const float *pz, const float *radius,
                                      int32_t node_slots,
                                      const int32_t *box_start, int32_t box_start_count,
                                      const int32_t *box_nodes, int32_t box_node_count,
                                      const int32_t *node_box,
                                      int32_t n, int32_t side, int32_t stride, float margin,
                                      int32_t *out_count, int32_t *out_ids) {
    if (embryo_metal_init() != 1) return 1;
    @autoreleasepool {
        int64_t fbytes = (int64_t)node_slots * (int64_t)sizeof(float);
        int64_t ibytes = (int64_t)node_slots * (int64_t)sizeof(int32_t);
        if (!embryo_metal_upload(BUF_PX, px, fbytes) || !embryo_metal_upload(BUF_PY, py, fbytes) ||
            !embryo_metal_upload(BUF_PZ, pz, fbytes) || !embryo_metal_upload(BUF_RADIUS, radius, fbytes) ||
            !embryo_metal_upload(BUF_BOX_START, box_start, (int64_t)box_start_count * (int64_t)sizeof(int32_t)) ||
            !embryo_metal_upload(BUF_BOX_NODES, box_nodes, (int64_t)box_node_count * (int64_t)sizeof(int32_t)) ||
            !embryo_metal_upload(BUF_NODE_BOX, node_box, ibytes)) {
            return 2;
        }
        int64_t ids_bytes = (int64_t)node_slots * (int64_t)stride * (int64_t)sizeof(int32_t);
        id<MTLBuffer> counts = embryo_metal_buffer(BUF_OUT_COUNT, ibytes);
        id<MTLBuffer> ids = embryo_metal_buffer(BUF_OUT_IDS, ids_bytes);
        if (!counts || !ids) return 2;

        id<MTLCommandBuffer> command = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        [encoder setComputePipelineState:g_prefilter];
        [encoder setBuffer:g_buffers[BUF_PX] offset:0 atIndex:0];
        [encoder setBuffer:g_buffers[BUF_PY] offset:0 atIndex:1];
        [encoder setBuffer:g_buffers[BUF_PZ] offset:0 atIndex:2];
        [encoder setBuffer:g_buffers[BUF_RADIUS] offset:0 atIndex:3];
        [encoder setBuffer:g_buffers[BUF_BOX_START] offset:0 atIndex:4];
        [encoder setBuffer:g_buffers[BUF_BOX_NODES] offset:0 atIndex:5];
        [encoder setBuffer:g_buffers[BUF_NODE_BOX] offset:0 atIndex:6];
        [encoder setBuffer:counts offset:0 atIndex:7];
        [encoder setBuffer:ids offset:0 atIndex:8];
        [encoder setBytes:&n length:sizeof(n) atIndex:9];
        [encoder setBytes:&side length:sizeof(side) atIndex:10];
        [encoder setBytes:&stride length:sizeof(stride) atIndex:11];
        [encoder setBytes:&margin length:sizeof(margin) atIndex:12];
        NSUInteger width = g_prefilter.maxTotalThreadsPerThreadgroup;
        if (width > 256) width = 256;
        if (width > (NSUInteger)n) width = (NSUInteger)n;
        if (width < 1) width = 1;
        [encoder dispatchThreads:MTLSizeMake((NSUInteger)n, 1, 1) threadsPerThreadgroup:MTLSizeMake(width, 1, 1)];
        [encoder endEncoding];
        [command commit];
        [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) return 2;
        memcpy(out_count, [counts contents], (size_t)ibytes);
        memcpy(out_ids, [ids contents], (size_t)ids_bytes);
        return 0;
    }
}
/* ---------------------------------------------------------------------
   Shared buffers the CPU and GPU both address. embryo_gpu_shared_alloc
   returns the host pointer of a zeroed shared-storage MTLBuffer and keeps
   the pair in a table, so a kernel can bind a Flow-owned array by pointer
   without copying. Pointers outside the table go through staging copies. */
#define SHARED_TABLE_MAX 64
static id<MTLBuffer> g_shared_buffers[SHARED_TABLE_MAX];
static void *g_shared_ptrs[SHARED_TABLE_MAX];
static int g_shared_count = 0;

void *embryo_gpu_shared_alloc(int64_t bytes) {
    if (embryo_metal_init() != 1 || g_shared_count >= SHARED_TABLE_MAX) return NULL;
    if (bytes < 16) bytes = 16;
    id<MTLBuffer> buffer = [g_device newBufferWithLength:(NSUInteger)bytes options:MTLResourceStorageModeShared];
    if (!buffer) return NULL;
    memset([buffer contents], 0, (size_t)bytes);
    g_shared_buffers[g_shared_count] = buffer;
    g_shared_ptrs[g_shared_count] = [buffer contents];
    g_shared_count++;
    return [buffer contents];
}

void embryo_gpu_shared_free(void *ptr) {
    for (int i = 0; i < g_shared_count; i++) {
        if (g_shared_ptrs[i] == ptr) {
            g_shared_buffers[i] = nil;
            g_shared_count--;
            g_shared_buffers[i] = g_shared_buffers[g_shared_count];
            g_shared_ptrs[i] = g_shared_ptrs[g_shared_count];
            g_shared_buffers[g_shared_count] = nil;
            g_shared_ptrs[g_shared_count] = NULL;
            return;
        }
    }
}

static id<MTLBuffer> shared_lookup(const void *ptr) {
    for (int i = 0; i < g_shared_count; i++) if (g_shared_ptrs[i] == ptr) return g_shared_buffers[i];
    return nil;
}

/* Staging slots for arrays the GPU reads or writes by copy. */
enum { ST_NODEF, ST_NODEI, ST_ROWS, ST_COUNTS, ST_ACT_COUNTS, ST_ACT_TYPES, ST_ACT_VALUES, ST_KADH, ST_DNEIGH,
       ST_RECORDS, ST_KINDS, ST_PARTNER, ST_PKINDS, ST_PSTAMP, ST_PREVERSE, ST_SPRING, ST_FMEANV, ST_TALONE, ST_ERRORS, ST_COUNT };
static id<MTLBuffer> g_stage[ST_COUNT];
static int64_t g_stage_capacity[ST_COUNT];

static id<MTLBuffer> stage_buffer(int slot, int64_t bytes) {
    if (bytes < 16) bytes = 16;
    if (g_stage[slot] == nil || g_stage_capacity[slot] < bytes) {
        int64_t capacity = g_stage_capacity[slot] * 2;
        if (capacity < bytes) capacity = bytes;
        g_stage[slot] = [g_device newBufferWithLength:(NSUInteger)capacity options:MTLResourceStorageModeShared];
        g_stage_capacity[slot] = g_stage[slot] ? capacity : 0;
    }
    return g_stage[slot];
}

/* Bind `ptr` (bytes long) at `index`: directly when it is a shared buffer,
   otherwise through a staging copy. Returns the staging buffer used or nil. */
static id<MTLBuffer> bind_array(id<MTLComputeCommandEncoder> encoder, int index, int slot, const void *ptr, int64_t bytes, int copy_in) {
    id<MTLBuffer> shared = shared_lookup(ptr);
    if (shared) { [encoder setBuffer:shared offset:0 atIndex:(NSUInteger)index]; return nil; }
    id<MTLBuffer> stage = stage_buffer(slot, bytes);
    if (!stage) return nil;
    if (copy_in && ptr) memcpy([stage contents], ptr, (size_t)bytes);
    [encoder setBuffer:stage offset:0 atIndex:(NSUInteger)index];
    return stage;
}

typedef struct {
    int32_t nd, stride, active_stride, kadh_ld, generation, ffu3, ffu4, ffu9, ffu23, pad[3];
    uint64_t epsilod, angletor;
} EmbryoForceParams;

static id<MTLComputePipelineState> g_force_exact = nil;
static id<MTLComputePipelineState> g_force_preview = nil;
static int g_force_state = 0;

static int force_pipelines_init(void) {
    if (g_force_state != 0) return g_force_state;
    @autoreleasepool {
        NSError *error = nil;
        id<MTLLibrary> library = load_library(@"force_pairs", embryo_metal_force_source, &error);
        if (!library) { NSLog(@"embryo_metal: force kernel compile failed: %@", error); g_force_state = -1; return -1; }
        id<MTLFunction> fe = [library newFunctionWithName:@"force_pairs_exact64"];
        id<MTLFunction> fp = [library newFunctionWithName:@"force_pairs_preview"];
        g_force_exact = fe ? load_pipeline(fe, @"force_pairs", &error) : nil;
        g_force_preview = fp ? load_pipeline(fp, @"force_pairs", &error) : nil;
        g_force_state = (g_force_exact && g_force_preview) ? 1 : -1;
        if (g_force_state < 0) NSLog(@"embryo_metal: force pipeline failed: %@", error);
        return g_force_state;
    }
}

/* Phase 1 of the force computation on the GPU. `exact` selects the software
   binary64 kernel (bit for bit equal to the CPU) or the float32 preview.
   Rows are the full-stride neighbor rows; they are compacted to `stride`
   for the kernel and dneigh is scattered back. Records, kinds, partner
   arrays, stamps and the reverse column cache are bound directly when they
   come from embryo_gpu_shared_alloc. Returns 0 on success, 1 when Metal or
   the kernel is unavailable, 2 on a buffer failure. */
int32_t embryo_gpu_force_pairs(int32_t exact, int32_t nd, int32_t ld, int32_t stride, int32_t active_stride,
                               int32_t kadh_ld, int32_t kadh_count, int32_t generation,
                               int32_t ffu3, int32_t ffu4, int32_t ffu9, int32_t ffu23,
                               double epsilod, double angletor,
                               const double *nodef, const int32_t *nodei,
                               const int32_t *neigh_full, const int32_t *nneigh, double *dneigh_full,
                               const int32_t *active_counts, const int32_t *active_types, const double *active_values,
                               const double *kadh,
                               double *records, int32_t *kinds, double *partner, int32_t *partner_kinds,
                               int32_t *partner_stamp, int32_t *partner_reverse,
                               double *spring_out, double *fmeanv_out, int32_t *talone_delta, int32_t *errors) {
    if (embryo_metal_init() != 1 || force_pipelines_init() != 1) return 1;
    static int stats = -1;
    static double t_compact = 0, t_gpu = 0, t_back = 0; static long calls = 0;
    if (stats < 0) { const char *e = getenv("EMBRYO_PARALLEL_STATS"); stats = (e && e[0] == '1') ? 1 : 0; }
    struct timespec ts0, ts1, ts2, ts3;
    if (stats) clock_gettime(CLOCK_MONOTONIC, &ts0);
    @autoreleasepool {
        int64_t rows_n = (int64_t)nd + 1;
        int64_t cells = rows_n * (int64_t)stride;
        /* compact rows */
        id<MTLBuffer> rows_stage = stage_buffer(ST_ROWS, cells * sizeof(int32_t));
        id<MTLBuffer> dneigh_stage = stage_buffer(ST_DNEIGH, cells * sizeof(double));
        if (!rows_stage || !dneigh_stage) return 2;
        int32_t *rows = (int32_t *)[rows_stage contents];
        for (int32_t i = 1; i <= nd; i++) {
            int32_t count = nneigh[i];
            if (count > stride - 1) count = stride - 1;
            memcpy(rows + (int64_t)i * stride + 1, neigh_full + (int64_t)i * ld + 1, (size_t)count * sizeof(int32_t));
        }
        id<MTLCommandBuffer> command = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        if (stats) clock_gettime(CLOCK_MONOTONIC, &ts1);
        [encoder setComputePipelineState:exact ? g_force_exact : g_force_preview];
        bind_array(encoder, 0, ST_NODEF, nodef, rows_n * 13 * sizeof(double), 1);
        bind_array(encoder, 1, ST_NODEI, nodei, rows_n * 4 * sizeof(int32_t), 1);
        [encoder setBuffer:rows_stage offset:0 atIndex:2];
        bind_array(encoder, 3, ST_COUNTS, nneigh, rows_n * sizeof(int32_t), 1);
        bind_array(encoder, 4, ST_ACT_COUNTS, active_counts, rows_n * sizeof(int32_t), 1);
        int64_t active_cells = rows_n * (int64_t)(active_stride > 0 ? active_stride : 1);
        bind_array(encoder, 5, ST_ACT_TYPES, active_types, active_cells * sizeof(int32_t), active_types != NULL);
        bind_array(encoder, 6, ST_ACT_VALUES, active_values, active_cells * sizeof(double), active_values != NULL);
        bind_array(encoder, 7, ST_KADH, kadh, (int64_t)(kadh_count > 0 ? kadh_count : 1) * sizeof(double), kadh != NULL);
        EmbryoForceParams params;
        memset(&params, 0, sizeof(params));
        params.nd = nd; params.stride = stride; params.active_stride = active_stride; params.kadh_ld = kadh_ld;
        params.generation = generation; params.ffu3 = ffu3; params.ffu4 = ffu4; params.ffu9 = ffu9; params.ffu23 = ffu23;
        memcpy(&params.epsilod, &epsilod, 8); memcpy(&params.angletor, &angletor, 8);
        [encoder setBytes:&params length:sizeof(params) atIndex:8];
        [encoder setBuffer:dneigh_stage offset:0 atIndex:9];
        id<MTLBuffer> st_records = bind_array(encoder, 10, ST_RECORDS, records, cells * 12 * sizeof(double), 0);
        id<MTLBuffer> st_kinds = bind_array(encoder, 11, ST_KINDS, kinds, cells * sizeof(int32_t), 0);
        id<MTLBuffer> st_partner = bind_array(encoder, 12, ST_PARTNER, partner, cells * 12 * sizeof(double), 0);
        id<MTLBuffer> st_pkinds = bind_array(encoder, 13, ST_PKINDS, partner_kinds, cells * sizeof(int32_t), 0);
        id<MTLBuffer> st_pstamp = bind_array(encoder, 14, ST_PSTAMP, partner_stamp, cells * sizeof(int32_t), 1);
        id<MTLBuffer> st_preverse = bind_array(encoder, 15, ST_PREVERSE, partner_reverse, cells * sizeof(int32_t), 1);
        id<MTLBuffer> st_spring = bind_array(encoder, 16, ST_SPRING, spring_out, rows_n * 3 * sizeof(double), 0);
        id<MTLBuffer> st_fmeanv = bind_array(encoder, 17, ST_FMEANV, fmeanv_out, rows_n * sizeof(double), 0);
        id<MTLBuffer> st_talone = bind_array(encoder, 18, ST_TALONE, talone_delta, rows_n * sizeof(int32_t), 0);
        id<MTLBuffer> st_errors = bind_array(encoder, 19, ST_ERRORS, errors, rows_n * sizeof(int32_t), 0);
        NSUInteger width = (exact ? g_force_exact : g_force_preview).maxTotalThreadsPerThreadgroup;
        if (width > 128) width = 128;
        if (width > (NSUInteger)nd) width = (NSUInteger)nd;
        if (width < 1) width = 1;
        [encoder dispatchThreads:MTLSizeMake((NSUInteger)nd, 1, 1) threadsPerThreadgroup:MTLSizeMake(width, 1, 1)];
        [encoder endEncoding];
        [command commit];
        [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) return 2;
        if (stats) clock_gettime(CLOCK_MONOTONIC, &ts2);
        /* copy back staged outputs */
        const double *dneigh_compact = (const double *)[dneigh_stage contents];
        for (int32_t i = 1; i <= nd; i++) {
            int32_t count = nneigh[i];
            if (count > stride - 1) count = stride - 1;
            memcpy(dneigh_full + (int64_t)i * ld + 1, dneigh_compact + (int64_t)i * stride + 1, (size_t)count * sizeof(double));
        }
        if (st_records) memcpy(records, [st_records contents], (size_t)(cells * 12 * sizeof(double)));
        if (st_kinds) memcpy(kinds, [st_kinds contents], (size_t)(cells * sizeof(int32_t)));
        if (st_partner) memcpy(partner, [st_partner contents], (size_t)(cells * 12 * sizeof(double)));
        if (st_pkinds) memcpy(partner_kinds, [st_pkinds contents], (size_t)(cells * sizeof(int32_t)));
        if (st_pstamp) memcpy(partner_stamp, [st_pstamp contents], (size_t)(cells * sizeof(int32_t)));
        if (st_preverse) memcpy(partner_reverse, [st_preverse contents], (size_t)(cells * sizeof(int32_t)));
        if (st_spring) memcpy(spring_out, [st_spring contents], (size_t)(rows_n * 3 * sizeof(double)));
        if (st_fmeanv) memcpy(fmeanv_out, [st_fmeanv contents], (size_t)(rows_n * sizeof(double)));
        if (st_talone) memcpy(talone_delta, [st_talone contents], (size_t)(rows_n * sizeof(int32_t)));
        if (st_errors) memcpy(errors, [st_errors contents], (size_t)(rows_n * sizeof(int32_t)));
        if (stats) {
            clock_gettime(CLOCK_MONOTONIC, &ts3);
            t_compact += (ts1.tv_sec - ts0.tv_sec) + (ts1.tv_nsec - ts0.tv_nsec) * 1e-9;
            t_gpu += (ts2.tv_sec - ts1.tv_sec) + (ts2.tv_nsec - ts1.tv_nsec) * 1e-9;
            t_back += (ts3.tv_sec - ts2.tv_sec) + (ts3.tv_nsec - ts2.tv_nsec) * 1e-9;
            calls++;
            if (calls % 200 == 0) fprintf(stderr, "embryo_gpu_force_pairs: %ld calls, per call: compact %.1f us, encode+gpu %.1f us, copy back %.1f us\n", calls, t_compact * 1e6 / calls, t_gpu * 1e6 / calls, t_back * 1e6 / calls);
        }
        return 0;
    }
}

/* Software binary64 conformance: runs softdouble_test over n operand pairs.
   Returns 0 on success, 1 when Metal is unavailable, 2 when the kernel did
   not compile or run. */
int32_t embryo_gpu_softdouble_test(const uint64_t *a, const uint64_t *b, int32_t n,
                                   uint64_t *out_add, uint64_t *out_sub, uint64_t *out_mul,
                                   uint64_t *out_div, uint64_t *out_sqrt, uint32_t *out_cmp) {
    if (embryo_metal_init() != 1) return 1;
    @autoreleasepool {
        static id<MTLComputePipelineState> pipeline = nil;
        if (!pipeline) {
            NSError *error = nil;
            id<MTLLibrary> library = load_library(@"softdouble", embryo_metal_softdouble_source, &error);
            if (!library) { NSLog(@"embryo_metal: softdouble compile failed: %@", error); return 2; }
            id<MTLFunction> fn = [library newFunctionWithName:@"softdouble_test"];
            pipeline = fn ? load_pipeline(fn, @"softdouble", &error) : nil;
            if (!pipeline) { NSLog(@"embryo_metal: softdouble pipeline failed: %@", error); return 2; }
        }
        NSUInteger bytes = (NSUInteger)n * sizeof(uint64_t);
        id<MTLBuffer> ba = [g_device newBufferWithBytes:a length:bytes options:MTLResourceStorageModeShared];
        id<MTLBuffer> bb = [g_device newBufferWithBytes:b length:bytes options:MTLResourceStorageModeShared];
        id<MTLBuffer> outs[5];
        for (int i = 0; i < 5; i++) outs[i] = [g_device newBufferWithLength:bytes options:MTLResourceStorageModeShared];
        id<MTLBuffer> bcmp = [g_device newBufferWithLength:(NSUInteger)n * sizeof(uint32_t) options:MTLResourceStorageModeShared];
        id<MTLCommandBuffer> command = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> encoder = [command computeCommandEncoder];
        [encoder setComputePipelineState:pipeline];
        [encoder setBuffer:ba offset:0 atIndex:0];
        [encoder setBuffer:bb offset:0 atIndex:1];
        for (int i = 0; i < 5; i++) [encoder setBuffer:outs[i] offset:0 atIndex:2 + i];
        [encoder setBuffer:bcmp offset:0 atIndex:7];
        uint32_t count = (uint32_t)n;
        [encoder setBytes:&count length:sizeof(count) atIndex:8];
        NSUInteger width = pipeline.maxTotalThreadsPerThreadgroup; if (width > 256) width = 256; if (width > (NSUInteger)n) width = (NSUInteger)n;
        [encoder dispatchThreads:MTLSizeMake((NSUInteger)n, 1, 1) threadsPerThreadgroup:MTLSizeMake(width, 1, 1)];
        [encoder endEncoding];
        [command commit];
        [command waitUntilCompleted];
        if (command.status != MTLCommandBufferStatusCompleted) return 2;
        memcpy(out_add, [outs[0] contents], bytes); memcpy(out_sub, [outs[1] contents], bytes);
        memcpy(out_mul, [outs[2] contents], bytes); memcpy(out_div, [outs[3] contents], bytes);
        memcpy(out_sqrt, [outs[4] contents], bytes); memcpy(out_cmp, [bcmp contents], (size_t)n * sizeof(uint32_t));
        return 0;
    }
}
#else
void *embryo_gpu_shared_alloc(int64_t bytes) { (void)bytes; return NULL; }
void embryo_gpu_shared_free(void *ptr) { (void)ptr; }
int32_t embryo_gpu_force_pairs(int32_t exact, int32_t nd, int32_t ld, int32_t stride, int32_t active_stride,
                               int32_t kadh_ld, int32_t kadh_count, int32_t generation,
                               int32_t ffu3, int32_t ffu4, int32_t ffu9, int32_t ffu23, double epsilod, double angletor,
                               const double *nodef, const int32_t *nodei, const int32_t *neigh_full, const int32_t *nneigh, double *dneigh_full,
                               const int32_t *active_counts, const int32_t *active_types, const double *active_values, const double *kadh,
                               double *records, int32_t *kinds, double *partner, int32_t *partner_kinds, int32_t *partner_stamp, int32_t *partner_reverse,
                               double *spring_out, double *fmeanv_out, int32_t *talone_delta, int32_t *errors) {
    (void)exact; (void)nd; (void)ld; (void)stride; (void)active_stride; (void)kadh_ld; (void)kadh_count; (void)generation; (void)ffu3; (void)ffu4; (void)ffu9; (void)ffu23;
    (void)epsilod; (void)angletor; (void)nodef; (void)nodei; (void)neigh_full; (void)nneigh; (void)dneigh_full; (void)active_counts; (void)active_types; (void)active_values; (void)kadh;
    (void)records; (void)kinds; (void)partner; (void)partner_kinds; (void)partner_stamp; (void)partner_reverse; (void)spring_out; (void)fmeanv_out; (void)talone_delta; (void)errors;
    return 1;
}
int32_t embryo_gpu_available(void) { return 0; }
int32_t embryo_gpu_softdouble_test(const uint64_t *a, const uint64_t *b, int32_t n,
                                   uint64_t *out_add, uint64_t *out_sub, uint64_t *out_mul,
                                   uint64_t *out_div, uint64_t *out_sqrt, uint32_t *out_cmp) {
    (void)a; (void)b; (void)n; (void)out_add; (void)out_sub; (void)out_mul; (void)out_div; (void)out_sqrt; (void)out_cmp;
    return 1;
}
const char *embryo_gpu_device_name(void) { return ""; }
int32_t embryo_gpu_neighbor_prefilter(const float *px, const float *py, const float *pz, const float *radius,
                                      int32_t node_slots, const int32_t *box_start, int32_t box_start_count,
                                      const int32_t *box_nodes, int32_t box_node_count, const int32_t *node_box,
                                      int32_t n, int32_t side, int32_t stride, float margin,
                                      int32_t *out_count, int32_t *out_ids) {
    (void)px; (void)py; (void)pz; (void)radius; (void)node_slots; (void)box_start; (void)box_start_count;
    (void)box_nodes; (void)box_node_count; (void)node_box; (void)n; (void)side; (void)stride; (void)margin;
    (void)out_count; (void)out_ids;
    return 1;
}
#endif

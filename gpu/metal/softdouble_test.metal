// Conformance kernel for softdouble.metal: one thread per operand pair.
kernel void softdouble_test(device const ulong* a [[buffer(0)]],
                            device const ulong* b [[buffer(1)]],
                            device ulong* out_add [[buffer(2)]],
                            device ulong* out_sub [[buffer(3)]],
                            device ulong* out_mul [[buffer(4)]],
                            device ulong* out_div [[buffer(5)]],
                            device ulong* out_sqrt [[buffer(6)]],
                            device uint* out_cmp [[buffer(7)]],
                            constant uint& n [[buffer(8)]],
                            uint tid [[thread_position_in_grid]]) {
    if (tid >= n) return;
    sd x = a[tid], y = b[tid];
    out_add[tid] = sd_add(x, y);
    out_sub[tid] = sd_sub(x, y);
    out_mul[tid] = sd_mul(x, y);
    out_div[tid] = sd_div(x, y);
    out_sqrt[tid] = sd_sqrt(sd_abs(x));
    out_cmp[tid] = (sd_lt(x, y) ? 1u : 0u) | (sd_le(x, y) ? 2u : 0u) | (sd_eq(x, y) ? 4u : 0u);
}

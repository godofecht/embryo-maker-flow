// Phase 1 of the two-phase force computation (see force_pairs_range in
// src/biomechanic.flow) as a Metal kernel, one thread per node. The body
// is a template over the arithmetic type: `float` gives the preview mode,
// `SD` (software binary64 from softdouble.metal) gives results identical to
// the CPU bit for bit. Both write the same record layout the CPU's phase 2
// replays, as double bit patterns.
//
// Rows are compact copies of the neighbor rows with stride `stride`; the
// host scatters dneigh back into the full rows.

struct SD {
    ulong v;
};
inline SD mk(ulong v) { SD r; r.v = v; return r; }
inline SD operator+(SD a, SD b) { return mk(sd_add(a.v, b.v)); }
inline SD operator-(SD a, SD b) { return mk(sd_sub(a.v, b.v)); }
inline SD operator*(SD a, SD b) { return mk(sd_mul(a.v, b.v)); }
inline SD operator/(SD a, SD b) { return mk(sd_div(a.v, b.v)); }
inline SD operator-(SD a) { return mk(sd_neg(a.v)); }
inline bool operator<(SD a, SD b) { return sd_lt(a.v, b.v); }
inline bool operator<=(SD a, SD b) { return sd_le(a.v, b.v); }
inline bool operator>(SD a, SD b) { return sd_gt(a.v, b.v); }
inline bool operator>=(SD a, SD b) { return sd_ge(a.v, b.v); }
inline bool operator==(SD a, SD b) { return sd_eq(a.v, b.v); }
inline bool operator!=(SD a, SD b) { return !sd_eq(a.v, b.v); }
inline SD sqrt(SD a) { return mk(sd_sqrt(a.v)); }
inline SD fabs(SD a) { return mk(sd_abs(a.v)); }

// Conversions between the double bit patterns in the buffers and the
// working type.
template <typename R> inline R from_bits(ulong bits);
template <> inline SD from_bits<SD>(ulong bits) { return mk(bits); }
template <> inline float from_bits<float>(ulong bits) {
    // round to nearest even; overflow to inf, underflow flushes toward zero
    ulong sign = bits >> 63;
    int e = int((bits >> 52) & 0x7FF);
    ulong m = bits & 0x000FFFFFFFFFFFFFul;
    if (e == 0x7FF) return as_type<float>(uint(sign << 31) | 0x7F800000u | uint(m != 0 ? 0x400000u : 0u));
    if (e == 0 && m == 0) return as_type<float>(uint(sign << 31));
    int fe = e - 1023 + 127;
    if (fe >= 0xFF) return as_type<float>(uint(sign << 31) | 0x7F800000u);
    if (fe <= 0) return as_type<float>(uint(sign << 31));
    ulong sig = m | 0x0010000000000000ul;          // 53 bits
    ulong mant = sig >> 29;                         // 24 bits
    ulong rest = sig & ((1ul << 29) - 1ul);
    ulong half_unit = 1ul << 28;
    if (rest > half_unit || (rest == half_unit && (mant & 1ul))) mant += 1;
    if (mant >> 24) { mant >>= 1; fe += 1; if (fe >= 0xFF) return as_type<float>(uint(sign << 31) | 0x7F800000u); }
    return as_type<float>(uint(sign << 31) | (uint(fe) << 23) | uint(mant & 0x7FFFFFu));
}
template <typename R> inline ulong to_bits(R v);
template <> inline ulong to_bits<SD>(SD v) { return v.v; }
template <> inline ulong to_bits<float>(float v) { return sd_from_float(v); }
template <typename R> inline R from_int(int v);
template <> inline SD from_int<SD>(int v) { return mk(sd_from_int(v)); }
template <> inline float from_int<float>(int v) { return float(v); }
template <typename R> inline R zero();
template <> inline SD zero<SD>() { return mk(0ul); }
template <> inline float zero<float>() { return 0.0f; }

// Node field layout in the f64 input block (13 per node): x y z add eqd you
// adh rep rec erp est eqs hoo. Integer block (4 per node): tipus altre icel fix.
#define NF 13
#define NI 4
#define F_X 0
#define F_Y 1
#define F_Z 2
#define F_ADD 3
#define F_EQD 4
#define F_YOU 5
#define F_ADH 6
#define F_REP 7
#define F_REC 8
#define F_ERP 9
#define F_EST 10
#define F_EQS 11
#define F_HOO 12
#define PAIR_FIELDS 12

struct ForceParams {
    int nd;
    int stride;
    int active_stride;
    int kadh_ld;
    int generation;
    int ffu3;     // torsion off when 1
    int ffu4;
    int ffu9;
    int ffu23;
    int pad[3];
    ulong epsilod;
    ulong angletor;
};

template <typename R>
inline void force_pairs_body(uint tid,
                             device const ulong *nodef, device const int *nodei,
                             device const int *rows, device const int *counts,
                             device const int *active_counts, device const int *active_types, device const ulong *active_values,
                             device const ulong *kadh,
                             constant ForceParams &p,
                             device ulong *dneigh_out, device ulong *records, device int *kinds,
                             device ulong *partner, device int *partner_kinds, device int *partner_stamp, device int *partner_reverse,
                             device ulong *spring_out, device ulong *fmeanv_out, device int *talone_delta, device int *errors) {
    int nod = int(tid) + 1;
    if (nod > p.nd) return;
    const int stride = p.stride;
    const R EPSILOD = from_bits<R>(p.epsilod);
    const R angletor = from_bits<R>(p.angletor);
    const R two = from_int<R>(2);
    const R one = from_int<R>(1);
    const R one_half = from_bits<R>(0x3FE0000000000000ul);
#define NODEF(id, f) from_bits<R>(nodef[(id) * NF + (f)])
#define NODEI(id, f) nodei[(id) * NI + (f)]
    const int row_base = nod * stride;
    const int neighbor_count = counts[nod];
    const R ix = NODEF(nod, F_X), iy = NODEF(nod, F_Y), iz = NODEF(nod, F_Z);
    const int nod_tipus = NODEI(nod, 0), nod_altre = NODEI(nod, 1), nod_icel = NODEI(nod, 2), nod_fix = NODEI(nod, 3);
    errors[nod] = 0;
    talone_delta[nod] = 0;
    if (nod_fix == 2) {
        for (int c = 1; c <= neighbor_count; c++) {
            int other = rows[row_base + c];
            if (other < 1 || other > p.nd) { errors[nod] = 1; return; }
            R dx = NODEF(other, F_X) - ix, dy = NODEF(other, F_Y) - iy, dz = NODEF(other, F_Z) - iz;
            dneigh_out[row_base + c] = to_bits<R>(sqrt((dx * dx) + (dy * dy) + (dz * dz)));
            kinds[row_base + c] = 0;
        }
        return;
    }
    R sx = zero<R>(), sy = zero<R>(), sz = zero<R>();
    R cx = zero<R>(), cy = zero<R>(), cz = zero<R>();
    R spring_length = zero<R>();
    if (nod_tipus < 3) {
        int other = nod_altre;
        if (other < 1 || other > p.nd) { errors[nod] = 1; return; }
        cx = NODEF(other, F_X) - ix; cy = NODEF(other, F_Y) - iy; cz = NODEF(other, F_Z) - iz;
        spring_length = sqrt((cx * cx) + (cy * cy) + (cz * cz));
        if (spring_length == zero<R>()) { errors[nod] = 1; return; }
        R unit = one / spring_length;
        R stretch = spring_length - NODEF(nod, F_EQS) - NODEF(other, F_EQS);
        R spring_force = two * NODEF(nod, F_HOO) * stretch;
        sx = spring_force * cx * unit; sy = spring_force * cy * unit; sz = spring_force * cz * unit;
        fmeanv_out[nod] = to_bits<R>(stretch);
    } else {
        fmeanv_out[nod] = 0ul;
    }
    spring_out[nod * 3] = to_bits<R>(sx); spring_out[nod * 3 + 1] = to_bits<R>(sy); spring_out[nod * 3 + 2] = to_bits<R>(sz);
    int alone = 0;
    for (int column = 1; column <= neighbor_count; column++) {
        int other = rows[row_base + column];
        if (other < 1 || other > p.nd) { errors[nod] = 1; return; }
        R dx = NODEF(other, F_X) - ix, dy = NODEF(other, F_Y) - iy, dz = NODEF(other, F_Z) - iz;
        R distance = sqrt((dx * dx) + (dy * dy) + (dz * dz));
        dneigh_out[row_base + column] = to_bits<R>(distance);
        kinds[row_base + column] = 0;
        int other_tipus = NODEI(other, 0), other_altre = NODEI(other, 1), other_icel = NODEI(other, 2), other_fix = NODEI(other, 3);
        if (other < nod && other_fix != 2) { alone = 1; continue; }
        alone = 1;
        if (distance == zero<R>()) { errors[nod] = 1; return; }
        R fd = distance;
        int twoep = 0;
        R ux = dx / distance, uy = dy / distance, uz = dz / distance;
        bool skip = false;
        R nod_add = NODEF(nod, F_ADD), other_add = NODEF(other, F_ADD);
        if (nod_tipus < 3 || other_tipus < 3) {
            if (nod_tipus < 3 && other_tipus < 3) {
                int other_apical = other_altre;
                if (other_apical < 1 || other_apical > p.nd) { errors[nod] = 1; return; }
                R icx = NODEF(other_apical, F_X) - NODEF(other, F_X);
                R icy = NODEF(other_apical, F_Y) - NODEF(other, F_Y);
                R icz = NODEF(other_apical, F_Z) - NODEF(other, F_Z);
                R posca = (icx * cx) + (icy * cy) + (icz * cz);
                if (nod_tipus == other_tipus && posca > EPSILOD) {
                    R mx = icx + cx, my = icy + cy, mz = icz + cz;
                    R ml = sqrt((mx * mx) + (my * my) + (mz * mz));
                    if (ml == zero<R>()) { errors[nod] = 1; return; }
                    R md = one / ml;
                    R projection = (mx * dx) + (my * dy) + (mz * dz);
                    R vertical = fabs(projection) * md;
                    R lateral2 = (distance * distance) - (vertical * vertical);
                    R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                    if (p.ffu23 == 1 && lateral - nod_add - other_add > EPSILOD) { skip = true; }
                    else {
                        R along = projection * md * md;
                        ux = (dx - mx * along) / lateral; uy = (dy - my * along) / lateral; uz = (dz - mz * along) / lateral;
                        fd = lateral; twoep = 1;
                    }
                } else if (nod_tipus == other_tipus) {
                    R mx = icx + cx, my = icy + cy, mz = icz + cz;
                    R ml2 = (mx * mx) + (my * my) + (mz * mz);
                    R projection = (cx * dx) + (cy * dy) + (cz * dz);
                    R radii = nod_add + other_add;
                    if (ml2 < EPSILOD) {
                        if (projection >= EPSILOD) { skip = true; }
                        else {
                            R vertical = (-projection) / spring_length;
                            if (vertical - radii >= EPSILOD) { skip = true; }
                            else {
                                R lateral2 = distance * distance;
                                R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                                if (fd - radii > EPSILOD) { skip = true; }
                                else {
                                    ux = (-cx) / spring_length; uy = (-cy) / spring_length; uz = (-cz) / spring_length;
                                    fd = lateral; twoep = 2;
                                }
                            }
                        }
                    } else {
                        R inverse_m = one / sqrt(ml2);
                        R vertical = fabs((mx * dx) + (my * dy) + (mz * dz)) * inverse_m;
                        if (vertical - radii >= EPSILOD) { skip = true; }
                        else {
                            R lateral2 = (distance * distance) - (vertical * vertical);
                            R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                            if (lateral - radii > EPSILOD) { skip = true; }
                            else {
                                R along = ((mx * dx) + (my * dy) + (mz * dz)) * inverse_m * inverse_m;
                                ux = (dx - mx * along) / lateral; uy = (dy - my * along) / lateral; uz = (dz - mz * along) / lateral;
                                fd = lateral;
                            }
                        }
                    }
                } else if (posca < zero<R>()) {
                    R projection = (cx * dx) + (cy * dy) + (cz * dz);
                    if (projection >= EPSILOD) { skip = true; }
                    else {
                        R vertical = (-projection) / spring_length;
                        R radii = nod_add + other_add;
                        if (vertical - radii >= EPSILOD) { skip = true; }
                        else {
                            R lateral2 = (distance * distance) - (vertical * vertical);
                            R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                            if (lateral - radii > EPSILOD) { skip = true; }
                            else {
                                ux = cx / spring_length; uy = cy / spring_length; uz = cz / spring_length;
                                fd = vertical; twoep = 2;
                            }
                        }
                    }
                } else {
                    skip = true;
                }
            } else if (nod_tipus < 3 && other_tipus >= 3) {
                R sxv = NODEF(nod_altre, F_X) - ix, syv = NODEF(nod_altre, F_Y) - iy, szv = NODEF(nod_altre, F_Z) - iz;
                R sl = sqrt((sxv * sxv) + (syv * syv) + (szv * szv));
                if (sl == zero<R>()) { errors[nod] = 1; return; }
                R projection = (sxv * dx) + (syv * dy) + (szv * dz);
                if (projection >= zero<R>()) { skip = true; }
                else {
                    fd = fabs(projection / sl);
                    R lateral2 = (distance * distance) - (fd * fd);
                    R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                    if (fd - nod_add - other_add >= zero<R>() || lateral - nod_add - other_add > EPSILOD) { skip = true; }
                    else { ux = (-sxv) / sl; uy = (-syv) / sl; uz = (-szv) / sl; }
                }
            } else if (nod_tipus >= 3 && other_tipus < 3) {
                R ox = NODEF(other_altre, F_X) - NODEF(other, F_X), oy = NODEF(other_altre, F_Y) - NODEF(other, F_Y), oz = NODEF(other_altre, F_Z) - NODEF(other, F_Z);
                R ol = sqrt((ox * ox) + (oy * oy) + (oz * oz));
                if (ol == zero<R>()) { errors[nod] = 1; return; }
                R projection = (ox * dx) + (oy * dy) + (oz * dz);
                if (projection <= zero<R>()) { skip = true; }
                else {
                    fd = projection / ol;
                    R lateral2 = (distance * distance) - (fd * fd);
                    R lateral = sqrt(lateral2 < EPSILOD ? EPSILOD : lateral2);
                    if (fd - nod_add - other_add >= zero<R>() || lateral - nod_add - other_add > EPSILOD) { skip = true; }
                    else { ux = ox / ol; uy = oy / ol; uz = oz / ol; }
                }
            } else {
                skip = true;
            }
        } else if (fd - nod_add - other_add > EPSILOD) {
            skip = true;
        }
        if (skip) continue;
        R force = zero<R>();
        R deqe = NODEF(nod, F_EQD) + NODEF(other, F_EQD);
        if (nod_icel == other_icel) {
            if (fd - deqe < (-EPSILOD)) force = (NODEF(nod, F_REP) + NODEF(other, F_REP)) * (fd - deqe);
            else force = (NODEF(nod, F_YOU) + NODEF(other, F_YOU)) * (fd - deqe);
        } else if (fd - deqe < (-EPSILOD)) {
            force = (NODEF(nod, F_REC) + NODEF(other, F_REC)) * (fd - deqe);
        } else {
            R adhesion = one_half * (NODEF(nod, F_ADH) + NODEF(other, F_ADH));
            int count_a = active_counts[nod], count_b = active_counts[other];
            for (int a = 1; a <= count_a; a++) {
                int ia = nod * p.active_stride + a;
                R expression_a = from_bits<R>(active_values[ia]);
                int ta = active_types[ia];
                for (int b = 1; b <= count_b; b++) {
                    int ib = other * p.active_stride + b;
                    R expression_b = from_bits<R>(active_values[ib]);
                    int tb = active_types[ib];
                    adhesion = adhesion + expression_a * expression_b * from_bits<R>(kadh[ta * p.kadh_ld + tb]);
                }
            }
            force = two * adhesion * (fd - deqe);
        }
        int pk = row_base + column;
        int rec = pk * PAIR_FIELDS;
        R fx = force * ux, fy = force * uy, fz = force * uz;
        records[rec] = to_bits<R>(fx); records[rec + 1] = to_bits<R>(fy); records[rec + 2] = to_bits<R>(fz);
        records[rec + 3] = to_bits<R>(force);
        R mean_force = force;
        if (p.ffu9 == 1) mean_force = fd - deqe;
        records[rec + 4] = to_bits<R>(mean_force);
        int kind = 1;
        if (twoep == 1) kind = 3;
        R partner_x = zero<R>(), partner_y = zero<R>(), partner_z = zero<R>();
        R rs0 = zero<R>(), rs1 = zero<R>(), rs2 = zero<R>();
        if (p.ffu3 == 0 && twoep == 1) {
            R mx = (NODEF(other_altre, F_X) - NODEF(other, F_X)) + cx;
            R my = (NODEF(other_altre, F_Y) - NODEF(other, F_Y)) + cy;
            R mz = (NODEF(other_altre, F_Z) - NODEF(other, F_Z)) + cz;
            R ml = sqrt((mx * mx) + (my * my) + (mz * mz));
            if (ml == zero<R>()) { errors[nod] = 1; return; }
            R inverse_m = one / ml;
            R projection = (mx * dx) + (my * dy) + (mz * dz);
            R angle_projection = projection * inverse_m;
            if (fabs(angle_projection) - angletor * distance > EPSILOD) {
                kind = kind + 4;
                R vertical_force = (NODEF(nod, F_EST) + NODEF(other, F_EST)) * angle_projection;
                rs0 = vertical_force * mx * inverse_m; rs1 = vertical_force * my * inverse_m; rs2 = vertical_force * mz * inverse_m;
                records[rec + 5] = to_bits<R>(rs0); records[rec + 6] = to_bits<R>(rs1); records[rec + 7] = to_bits<R>(rs2);
                R parallel_projection = ((cx * dx) + (cy * dy) + (cz * dz)) / spring_length;
                R parallel_force = (NODEF(nod, F_ERP) + NODEF(other, F_ERP)) * parallel_projection;
                R pair_x = dx / distance, pair_y = dy / distance, pair_z = dz / distance;
                records[rec + 8] = to_bits<R>(parallel_force * pair_x);
                records[rec + 9] = to_bits<R>(parallel_force * pair_y);
                records[rec + 10] = to_bits<R>(parallel_force * pair_z);
                R oax = NODEF(other_altre, F_X) - NODEF(other, F_X), oay = NODEF(other_altre, F_Y) - NODEF(other, F_Y), oaz = NODEF(other_altre, F_Z) - NODEF(other, F_Z);
                R other_spring_length = sqrt((oax * oax) + (oay * oay) + (oaz * oaz));
                if (other_spring_length == zero<R>()) { errors[nod] = 1; return; }
                R opposite_projection = (-((oax * dx) + (oay * dy) + (oaz * dz))) / other_spring_length;
                R opposite_force = (NODEF(nod, F_ERP) + NODEF(other, F_ERP)) * opposite_projection;
                partner_x = opposite_force * pair_x; partner_y = opposite_force * pair_y; partner_z = opposite_force * pair_z;
            }
        }
        kinds[pk] = kind;
        int partner_base = other * stride;
        int partner_count = counts[other];
        int partner_column = partner_reverse[pk];
        if (partner_column < 1 || partner_column > partner_count || rows[partner_base + partner_column] != nod) {
            partner_column = 0;
            for (int scan = 1; scan <= partner_count; scan++) {
                if (rows[partner_base + scan] == nod) { partner_column = scan; break; }
            }
            partner_reverse[pk] = partner_column;
        }
        if (partner_column == 0) { errors[nod] = 2; }
        else {
            int pslot = other * stride + partner_column;
            int pp = pslot * PAIR_FIELDS;
            partner[pp] = records[rec]; partner[pp + 1] = records[rec + 1]; partner[pp + 2] = records[rec + 2];
            partner[pp + 3] = records[rec + 3]; partner[pp + 4] = records[rec + 4];
            if ((kind & 4) != 0) {
                partner[pp + 5] = to_bits<R>(rs0); partner[pp + 6] = to_bits<R>(rs1); partner[pp + 7] = to_bits<R>(rs2);
                partner[pp + 8] = to_bits<R>(partner_x); partner[pp + 9] = to_bits<R>(partner_y); partner[pp + 10] = to_bits<R>(partner_z);
            }
            partner_kinds[pslot] = kind;
            partner_stamp[pslot] = p.generation;
        }
    }
    if (p.ffu4 == 1) talone_delta[nod] = alone == 0 ? 1 : -1;
#undef NODEF
#undef NODEI
}

#define FORCE_KERNEL(NAME, R) \
kernel void NAME(device const ulong *nodef [[buffer(0)]], device const int *nodei [[buffer(1)]], \
                 device const int *rows [[buffer(2)]], device const int *counts [[buffer(3)]], \
                 device const int *active_counts [[buffer(4)]], device const int *active_types [[buffer(5)]], device const ulong *active_values [[buffer(6)]], \
                 device const ulong *kadh [[buffer(7)]], constant ForceParams &p [[buffer(8)]], \
                 device ulong *dneigh_out [[buffer(9)]], device ulong *records [[buffer(10)]], device int *kinds [[buffer(11)]], \
                 device ulong *partner [[buffer(12)]], device int *partner_kinds [[buffer(13)]], device int *partner_stamp [[buffer(14)]], device int *partner_reverse [[buffer(15)]], \
                 device ulong *spring_out [[buffer(16)]], device ulong *fmeanv_out [[buffer(17)]], device int *talone_delta [[buffer(18)]], device int *errors [[buffer(19)]], \
                 uint tid [[thread_position_in_grid]]) { \
    force_pairs_body<R>(tid, nodef, nodei, rows, counts, active_counts, active_types, active_values, kadh, p, \
                        dneigh_out, records, kinds, partner, partner_kinds, partner_stamp, partner_reverse, spring_out, fmeanv_out, talone_delta, errors); \
}

FORCE_KERNEL(force_pairs_exact64, SD)
FORCE_KERNEL(force_pairs_preview, float)

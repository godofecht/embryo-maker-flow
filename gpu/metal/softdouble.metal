// Software IEEE 754 binary64 for Metal, which has no double type.
//
// Values travel as their 64 bit patterns (ulong). Every operation rounds to
// nearest, ties to even, exactly as the CPU does, so a kernel built from
// these matches the C build bit for bit. Subnormals, zeros, infinities and
// NaN are handled; signalling behaviour and NaN payloads are not preserved
// beyond "some NaN". Integer-only, so throughput is a few hundred ops per
// double operation; the force kernel runs a few thousand per pair.
#include <metal_stdlib>
using namespace metal;

typedef ulong sd;

struct u128 { ulong lo; ulong hi; };

inline ulong sd_mant(sd a) { return a & 0x000FFFFFFFFFFFFFul; }
inline int sd_exp(sd a) { return int((a >> 52) & 0x7FF); }
inline ulong sd_sign(sd a) { return a >> 63; }
inline bool sd_is_nan(sd a) { return sd_exp(a) == 0x7FF && sd_mant(a) != 0; }
inline bool sd_is_inf(sd a) { return sd_exp(a) == 0x7FF && sd_mant(a) == 0; }
inline bool sd_is_zero(sd a) { return (a & 0x7FFFFFFFFFFFFFFFul) == 0; }
constant sd SD_NAN = 0x7FF8000000000000ul;
constant sd SD_ZERO = 0ul;
constant sd SD_ONE = 0x3FF0000000000000ul;
constant sd SD_TWO = 0x4000000000000000ul;
constant sd SD_HALF = 0x3FE0000000000000ul;

inline sd sd_from_int(int v) {
    if (v == 0) return SD_ZERO;
    ulong sign = v < 0 ? 1ul : 0ul;
    ulong m = ulong(v < 0 ? -(long)v : (long)v);
    int lz = clz(m);
    int e = 63 - lz;
    ulong frac = (m << (lz + 1)) >> 12;   // exact for |v| < 2^53
    return (sign << 63) | (ulong(e + 1023) << 52) | frac;
}

inline sd sd_from_float(float f) {
    // exact: every float is a double
    uint bits = as_type<uint>(f);
    ulong sign = ulong(bits >> 31);
    int e = int((bits >> 23) & 0xFF);
    ulong m = ulong(bits & 0x7FFFFF);
    if (e == 0xFF) return (sign << 63) | 0x7FF0000000000000ul | (m << 29);
    if (e == 0) {
        if (m == 0) return sign << 63;
        int lz = clz(m) - 8;            // normalise the float subnormal
        m <<= lz + 1; m &= 0x7FFFFF;
        e = 1 - lz;                     // float exponent after shift (unbiased + 127 form)
        return (sign << 63) | (ulong(e - 127 + 1023 - 1) << 52) | (m << 29);
    }
    return (sign << 63) | (ulong(e - 127 + 1023) << 52) | (m << 29);
}

// Unpack into sign, unbiased exponent and a 53 bit significand with the
// hidden bit (subnormals normalised so the hidden bit is set).
struct sd_parts { ulong sign; int exp; ulong sig; };

inline sd_parts sd_unpack(sd a) {
    sd_parts p;
    p.sign = sd_sign(a);
    int e = sd_exp(a);
    ulong m = sd_mant(a);
    if (e == 0) {
        if (m == 0) { p.exp = 0; p.sig = 0; return p; }
        int shift = clz(m) - 11;
        p.sig = m << shift;
        p.exp = 1 - 1023 - shift;
    } else {
        p.sig = m | 0x0010000000000000ul;
        p.exp = e - 1023;
    }
    return p;
}

// Round a value given as sign, exponent (of the leading bit position 52 of
// `sig`, i.e. value = sig * 2^(exp-52)) with sticky/guard bits already in
// the low bits of a wider significand. `sig` here holds the significand
// shifted so that bit 54 is the leading one: bits 0..1 are guard and round,
// `sticky` collects everything below.
inline sd sd_round_pack(ulong sign, int exp, ulong sig55, bool sticky) {
    // sig55: leading one at bit 54, so 55 significant bits: 53 + guard + round.
    // Handle underflow into subnormals by shifting right with sticky.
    if (exp < -1022) {
        int shift = -1022 - exp;
        if (shift > 60) { sticky = sticky || sig55 != 0; sig55 = 0; }
        else { sticky = sticky || (sig55 & ((1ul << shift) - 1ul)) != 0; sig55 >>= shift; }
        exp = -1022;
    }
    ulong mant = sig55 >> 2;
    ulong guard = (sig55 >> 1) & 1ul;
    ulong round_bit = sig55 & 1ul;
    bool round_up = guard && (round_bit || sticky || (mant & 1ul));
    if (round_up) mant += 1;
    int e;
    if (mant >= 0x0020000000000000ul) {        // carried into bit 53
        mant >>= 1; exp += 1;
    }
    if (mant < 0x0010000000000000ul) {         // subnormal or zero
        e = 0;
    } else {
        e = exp + 1023;
        mant &= 0x000FFFFFFFFFFFFFul;
    }
    if (e >= 0x7FF) return (sign << 63) | 0x7FF0000000000000ul;
    return (sign << 63) | (ulong(e) << 52) | mant;
}

inline sd sd_add(sd a, sd b) {
    if (sd_is_nan(a) || sd_is_nan(b)) return SD_NAN;
    if (sd_is_inf(a)) { if (sd_is_inf(b) && sd_sign(a) != sd_sign(b)) return SD_NAN; return a; }
    if (sd_is_inf(b)) return b;
    if (sd_is_zero(a)) { if (sd_is_zero(b)) return (sd_sign(a) & sd_sign(b)) << 63; return b; }
    if (sd_is_zero(b)) return a;
    sd_parts x = sd_unpack(a), y = sd_unpack(b);
    // order by magnitude: x has the larger exponent (or equal with larger sig)
    if (y.exp > x.exp || (y.exp == x.exp && y.sig > x.sig)) { sd_parts t = x; x = y; y = t; }
    // 53 bit significands shifted left by 10 → leading one at bit 62; room for carry at 63
    ulong xs = x.sig << 10;
    ulong ys = y.sig << 10;
    int d = x.exp - y.exp;
    bool sticky = false;
    if (d > 0) {
        if (d >= 64) { sticky = ys != 0; ys = 0; }
        else { sticky = (ys & ((1ul << d) - 1ul)) != 0; ys >>= d; }
    }
    ulong sig; int exp = x.exp; ulong sign = x.sign;
    if (x.sign == y.sign) {
        sig = xs + ys;                       // leading one at bit 62 or 63
        if (sig >> 63) { sticky = sticky || (sig & 1ul); sig >>= 1; exp += 1; }
    } else {
        sig = xs - ys - (sticky ? 1ul : 0ul);   // borrow the sticky bit exactly
        // when sticky was set the true difference is xs - (ys + fraction), handled by
        // subtracting one more unit and keeping sticky as the inverted remainder
        if (sig == 0 && !sticky) return SD_ZERO;
        int lz = clz(sig) - 1;               // renormalise leading one to bit 62
        sig <<= lz; exp -= lz;
    }
    // sig: leading one at bit 62. Build sig55 = bits 62..8, sticky from bits 7..0.
    sticky = sticky || (sig & 0xFFul) != 0;
    return sd_round_pack(sign, exp, sig >> 8, sticky);
}

inline sd sd_neg(sd a) { return a ^ 0x8000000000000000ul; }
inline sd sd_sub(sd a, sd b) { return sd_add(a, sd_neg(b)); }
inline sd sd_abs(sd a) { return a & 0x7FFFFFFFFFFFFFFFul; }

inline u128 mul64(ulong a, ulong b) {
    ulong a0 = a & 0xFFFFFFFFul, a1 = a >> 32, b0 = b & 0xFFFFFFFFul, b1 = b >> 32;
    ulong p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    ulong mid = (p00 >> 32) + (p01 & 0xFFFFFFFFul) + (p10 & 0xFFFFFFFFul);
    u128 r;
    r.lo = (p00 & 0xFFFFFFFFul) | (mid << 32);
    r.hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
    return r;
}

inline sd sd_mul(sd a, sd b) {
    ulong sign = sd_sign(a) ^ sd_sign(b);
    if (sd_is_nan(a) || sd_is_nan(b)) return SD_NAN;
    if (sd_is_inf(a) || sd_is_inf(b)) { if (sd_is_zero(a) || sd_is_zero(b)) return SD_NAN; return (sign << 63) | 0x7FF0000000000000ul; }
    if (sd_is_zero(a) || sd_is_zero(b)) return sign << 63;
    sd_parts x = sd_unpack(a), y = sd_unpack(b);
    u128 p = mul64(x.sig, y.sig);           // 106 bit product: bits 104/105 lead
    int exp = x.exp + y.exp;
    // product of two 53 bit values with leading ones: 2^104 <= p < 2^106
    // normalise so the leading one sits at bit 62 of a 64 bit window
    ulong sig; bool sticky;
    if (p.hi & (1ul << 41)) {               // bit 105 set → leading one at 105
        sig = (p.hi << 21) | (p.lo >> 43);  // bits 105..43 → 62..0
        sticky = (p.lo & ((1ul << 43) - 1ul)) != 0;
        exp += 1;
    } else {                                // leading one at 104
        sig = (p.hi << 22) | (p.lo >> 42);
        sticky = (p.lo & ((1ul << 42) - 1ul)) != 0;
    }
    sticky = sticky || (sig & 0xFFul) != 0;
    return sd_round_pack(sign, exp, sig >> 8, sticky);
}

inline sd sd_div(sd a, sd b) {
    ulong sign = sd_sign(a) ^ sd_sign(b);
    if (sd_is_nan(a) || sd_is_nan(b)) return SD_NAN;
    if (sd_is_inf(a)) { if (sd_is_inf(b)) return SD_NAN; return (sign << 63) | 0x7FF0000000000000ul; }
    if (sd_is_inf(b)) return sign << 63;
    if (sd_is_zero(b)) { if (sd_is_zero(a)) return SD_NAN; return (sign << 63) | 0x7FF0000000000000ul; }
    if (sd_is_zero(a)) return sign << 63;
    sd_parts x = sd_unpack(a), y = sd_unpack(b);
    int exp = x.exp - y.exp;
    // long division: q = (x.sig << 55) / y.sig gives 55 or 56 significant bits
    ulong rem = x.sig, q = 0;
    if (rem < y.sig) { rem <<= 1; exp -= 1; }
    // now y.sig <= rem < 2*y.sig; produce 55 quotient bits
    for (int i = 0; i < 55; i++) {
        q <<= 1;
        if (rem >= y.sig) { rem -= y.sig; q |= 1ul; }
        rem <<= 1;
    }
    // q has its leading one at bit 54 (55 bits)
    bool sticky = rem != 0;
    return sd_round_pack(sign, exp, q, sticky);
}

inline sd sd_sqrt(sd a) {
    if (sd_is_nan(a)) return SD_NAN;
    if (sd_is_zero(a)) return a;
    if (sd_sign(a)) return SD_NAN;
    if (sd_is_inf(a)) return a;
    sd_parts x = sd_unpack(a);
    int exp = x.exp;
    ulong sig = x.sig;                      // 2^52 <= sig < 2^53, value = sig * 2^(exp-52)
    if (exp & 1) { sig <<= 1; exp -= 1; }   // make exponent even: value = sig * 2^(exp-52)
    // sqrt(sig * 2^(exp-52)) = sqrt(sig * 2^?)... compute integer sqrt of sig << 54 (or <<53)
    // r = floor(sqrt(sig << 56)) has 55 or 56 bits: use digit by digit on 128 bits.
    u128 n; n.hi = sig >> 8; n.lo = sig << 56;   // sig << 56, 109 bits max
    ulong r = 0; u128 rem; rem.hi = 0; rem.lo = 0;
    // process 128 bits two at a time from the top; 64 iterations
    for (int i = 0; i < 64; i++) {
        // rem = (rem << 2) | top two bits of n; n <<= 2
        ulong top = n.hi >> 62;
        n.hi = (n.hi << 2) | (n.lo >> 62); n.lo <<= 2;
        rem.hi = (rem.hi << 2) | (rem.lo >> 62); rem.lo = (rem.lo << 2) | top;
        // trial = (r << 2) | 1 ; if rem >= trial: rem -= trial, r = (r<<1)|1 else r <<= 1
        u128 trial; trial.lo = (r << 2) | 1ul; trial.hi = r >> 62;
        bool ge = rem.hi > trial.hi || (rem.hi == trial.hi && rem.lo >= trial.lo);
        if (ge) {
            ulong lo = rem.lo - trial.lo; ulong borrow = rem.lo < trial.lo ? 1ul : 0ul;
            rem.hi = rem.hi - trial.hi - borrow; rem.lo = lo;
            r = (r << 1) | 1ul;
        } else {
            r <<= 1;
        }
    }
    // r = floor(sqrt(sig << 56)) : sqrt(sig)*2^28, has 54 or 55 bits (sig in [2^52, 2^54))
    bool sticky = rem.lo != 0 || rem.hi != 0;
    // value = r * 2^(-28) * 2^((exp-52)/2) ... with exp even: sqrt(sig*2^(exp-52)) = sqrt(sig)*2^((exp-52)/2)
    // leading one of r at bit 54 or 55; shift so leading one sits at bit 54 for sd_round_pack
    int lead = 63 - clz(r);
    int out_exp = (exp - 52) / 2 + (lead - 28);   // r * 2^-28 has leading bit at (lead-28)
    ulong sig55;
    if (lead == 55) { sticky = sticky || (r & 1ul); sig55 = r >> 1; }
    else { sig55 = r; }   // lead == 54
    return sd_round_pack(0, out_exp, sig55, sticky);
}

// Comparisons (false for NaN like the CPU, except != which is true).
inline bool sd_lt(sd a, sd b) {
    if (sd_is_nan(a) || sd_is_nan(b)) return false;
    if (sd_is_zero(a) && sd_is_zero(b)) return false;
    bool sa = sd_sign(a), sb = sd_sign(b);
    if (sa != sb) return sa;
    return sa ? (a & 0x7FFFFFFFFFFFFFFFul) > (b & 0x7FFFFFFFFFFFFFFFul) : a < b;
}
inline bool sd_le(sd a, sd b) { if (sd_is_nan(a) || sd_is_nan(b)) return false; return sd_lt(a, b) || (sd_is_zero(a) && sd_is_zero(b)) || a == b; }
inline bool sd_gt(sd a, sd b) { return sd_lt(b, a); }
inline bool sd_ge(sd a, sd b) { return sd_le(b, a); }
inline bool sd_eq(sd a, sd b) { if (sd_is_nan(a) || sd_is_nan(b)) return false; return a == b || (sd_is_zero(a) && sd_is_zero(b)); }

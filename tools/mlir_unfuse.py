#!/usr/bin/env python3 -I
"""Split fused multiply-add ops in Flow's emitted MLIR into a multiply and an add.

The C backend is built with -ffp-contract=off so snapshots match the Fortran
reference bit for bit. flowc's MLIR emitter instead contracts a * b + c into
llvm.intr.fmuladd, which is how clang behaves with contraction on. This
rewrite restores the separate operations. It is exact for every form the
emitter produces: a negated factor stays a negated factor, and a negated
addend stays a negated addend, so x + (-y) equals x - y bit for bit.

usage: mlir_unfuse.py IN.mlir OUT.mlir
"""
import re
import sys

PATTERN = re.compile(
    r"^(?P<indent>[ \t]*)%(?P<name>[A-Za-z0-9_$.]+) = llvm\.intr\.fmuladd\("
    r"(?P<a>%[A-Za-z0-9_$.]+), (?P<b>%[A-Za-z0-9_$.]+), (?P<c>%[A-Za-z0-9_$.]+)\)"
    r" : \((?P<t>f32|f64), (?P=t), (?P=t)\) -> (?P=t)[ \t]*$",
    re.M,
)


def unfuse(text: str) -> tuple[str, int]:
    count = 0

    def replace(match: re.Match) -> str:
        nonlocal count
        count += 1
        g = match.groupdict()
        product = f"%fm{g['name']}"
        return (
            f"{g['indent']}{product} = llvm.fmul {g['a']}, {g['b']} : {g['t']}\n"
            f"{g['indent']}%{g['name']} = llvm.fadd {product}, {g['c']} : {g['t']}"
        )

    out = PATTERN.sub(replace, text)
    remaining = out.count("llvm.intr.fmuladd")
    if remaining:
        raise SystemExit(f"mlir_unfuse: {remaining} fmuladd op(s) in an unexpected form")
    return out, count


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        text = handle.read()
    out, count = unfuse(text)
    with open(argv[2], "w", encoding="utf-8") as handle:
        handle.write(out)
    print(f"mlir_unfuse: rewrote {count} fused multiply-add op(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

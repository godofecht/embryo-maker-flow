#!/usr/bin/env python3
"""Compile Metal libraries and native pipeline archives for the local GPU."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toolchain', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=repo / 'build/gpu/offline')
    args = parser.parse_args()
    tools = args.toolchain.resolve() / 'usr/bin'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    architecture = subprocess.check_output([str(tools / 'metal-arch')], text=True).strip()
    version = subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip()
    if not architecture or '\n' in architecture:
        raise RuntimeError('Expected one local GPU architecture')
    sources = {
        'neighbor_prefilter': ([repo / 'build/gpu/neighbor_prefilter.metal'], ['neighbor_prefilter']),
        'force_pairs': ([repo / 'gpu/metal/softdouble.metal', repo / 'gpu/metal/force_pairs.metal'], ['force_pairs_exact64', 'force_pairs_preview']),
        'softdouble': ([repo / 'gpu/metal/softdouble.metal', repo / 'gpu/metal/softdouble_test.metal'], ['softdouble_test']),
    }
    # Publish only after every library and archive compiled successfully.
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        stage = Path(temporary)
        for name, (files, functions) in sources.items():
            source = stage / (name + '.metal')
            source.write_text('\n'.join(p.read_text() for p in files))
            script = stage / (name + '.mtlp-json')
            script.write_text(json.dumps({'pipelines': {'compute_pipelines': [
                {'compute_function': f} for f in functions]}}))
            def run(tool, *arguments):
                subprocess.run([str(tools / tool), *map(str, arguments)], check=True)
            run('metal', '-target', 'air64-apple-macos' + version, '-fno-fast-math', '-c', source, '-o', stage / (name + '.air'))
            run('metallib', stage / (name + '.air'), '-o', stage / (name + '.metallib'))
            run('metal-tt', '-arch', architecture, '-macos-version-min', version,
                stage / (name + '.metallib'), script, '-o', stage / (name + '.archive'))
            print('Compiled', name, architecture, flush=True)
        for name in sources:
            for suffix in ('.metallib', '.archive'):
                os.replace(stage / (name + suffix), output / (name + suffix))
    (output / 'manifest.json').write_text(json.dumps(dict(architecture=architecture, macos=version), indent=2) + '\n')

if __name__ == '__main__':
    main()

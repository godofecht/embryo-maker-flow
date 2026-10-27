#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: tools/package_release.sh <macos-arm64|linux-x86_64> <server-binary> [version]" >&2
    exit 2
fi

target=$1
server_binary=$2
version=${3:-$(git -C "$repo_dir" describe --tags --exact-match 2>/dev/null | sed 's/^v//')}
if [ -z "$version" ]; then
    echo "version is required when HEAD has no version tag" >&2
    exit 2
fi
case "$target" in
    macos-arm64) archive_ext=zip ;;
    linux-x86_64) archive_ext=tar.gz ;;
    *) echo "unsupported target: $target" >&2; exit 2 ;;
esac
if [ ! -x "$server_binary" ]; then
    echo "server executable not found or not executable: $server_binary" >&2
    exit 1
fi

dist_dir="$repo_dir/dist"
stage="$dist_dir/EmbryoMaker-Flow"
archive="$dist_dir/EmbryoMaker-Flow-$target-v$version.$archive_ext"
rm -rf "$stage"
mkdir -p "$stage/reference" "$stage/ui" "$dist_dir"
cp "$server_binary" "$stage/EmbryoMaker"
cp "$repo_dir/LICENSE" "$stage/LICENSE"
cp "$repo_dir/docs/user-guide.md" "$stage/USER_GUIDE.md"
cp "$repo_dir/reference/config_file.txt" "$stage/reference/config_file.txt"
cp -R "$repo_dir/reference/examples" "$stage/reference/examples"
cp "$repo_dir/ui/index.html" "$repo_dir/ui/renderer.js" "$repo_dir/ui/studio.css" \
   "$repo_dir/ui/topology.html" "$repo_dir/ui/topology-core.js" \
   "$repo_dir/ui/favicon.svg" "$stage/ui/"

cat > "$stage/launch.sh" <<'LAUNCH'
#!/bin/sh
set -eu
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$bundle_dir"
port=${PORT:-8765}
./EmbryoMaker &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT HUP INT TERM
sleep 1
url="http://127.0.0.1:$port"
case "$(uname -s)" in
    Darwin) open "$url" >/dev/null 2>&1 || true ;;
    Linux) if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 || true; fi ;;
esac
wait "$server_pid"
LAUNCH
chmod +x "$stage/EmbryoMaker" "$stage/launch.sh"

if [ "$target" = macos-arm64 ]; then
    cat > "$stage/Start EmbryoMaker.command" <<'START'
#!/bin/sh
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/launch.sh"
START
    chmod +x "$stage/Start EmbryoMaker.command"
else
    cat > "$stage/start-linux.sh" <<'START'
#!/bin/sh
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/launch.sh"
START
    chmod +x "$stage/start-linux.sh"
fi

rm -f "$archive"
if [ "$archive_ext" = zip ]; then
    (cd "$dist_dir" && zip -qr "$(basename "$archive")" EmbryoMaker-Flow)
else
    (cd "$dist_dir" && tar --no-xattrs -czf "$(basename "$archive")" EmbryoMaker-Flow)
fi
shasum -a 256 "$archive" 2>/dev/null || sha256sum "$archive"
echo "Created $archive"


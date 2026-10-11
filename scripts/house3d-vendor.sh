#!/usr/bin/env bash
# Vendor a three.js release for the house 3D view as plain ES modules.
#
# Usage: scripts/house3d-vendor.sh <version>     (e.g. 0.186.1)
#
# Copies build/three.module.js, build/three.core.js, LICENSE and the addons the
# engine imports (plus whatever those import) into
# services/home/homeassistant/house3d/vendor/three-<version>/, keeping the
# examples/jsm layout. Each addon's bare 'three' import is rewritten to the
# relative path of that directory's build/three.module.js, so the engine and
# every addon share one three instance without an import map (HA cannot add
# one). Renovate does not see this directory: rerun with the new version, point
# house3d.js at the new directory, bump HOUSE3D_VERSION and remove the old one.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <three version>" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT_DIR/services/home/homeassistant/house3d/vendor/three-$VERSION"
ADDONS=(
  controls/OrbitControls.js
  postprocessing/EffectComposer.js
  postprocessing/RenderPass.js
  postprocessing/ShaderPass.js
  postprocessing/MaskPass.js
  postprocessing/Pass.js
  postprocessing/UnrealBloomPass.js
  postprocessing/OutputPass.js
  shaders/CopyShader.js
  shaders/LuminosityHighPassShader.js
  shaders/OutputShader.js
)

if [ -e "$DEST" ]; then
  echo "$DEST already exists; remove it first to re-vendor" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && npm pack --silent "three@$VERSION" >/dev/null && tar xzf "three-$VERSION.tgz")
PKG="$TMP/package"
JSM="$PKG/examples/jsm"

# Follow relative imports so a dependency added upstream is not silently missed.
queue=("${ADDONS[@]}")
seen=" "
while [ "${#queue[@]}" -gt 0 ]; do
  rel="${queue[0]}"
  queue=("${queue[@]:1}")
  case "$seen" in *" $rel "*) continue ;; esac
  seen="$seen$rel "
  [ -f "$JSM/$rel" ] || { echo "missing addon $rel in three@$VERSION" >&2; exit 1; }
  dir="$(dirname "$rel")"
  while IFS= read -r dep; do
    resolved="$(cd "$JSM/$dir" && cd "$(dirname "$dep")" && pwd)/$(basename "$dep")"
    queue+=("${resolved#"$JSM"/}")
  done < <(sed -nE "s#.*from[[:space:]]*['\"](\.{1,2}/[^'\"]+)['\"].*#\1#p" "$JSM/$rel")
done

mkdir -p "$DEST/build"
cp "$PKG/build/three.module.js" "$PKG/build/three.core.js" "$DEST/build/"
cp "$PKG/LICENSE" "$DEST/LICENSE"
for rel in $seen; do
  mkdir -p "$DEST/examples/jsm/$(dirname "$rel")"
  # examples/jsm/<dir>/<file>.js sits three levels below the version directory.
  up="../../"
  for _ in $(echo "$rel" | tr -cd '/' | fold -w1); do up="../$up"; done
  sed -E "s#from[[:space:]]*(['\"])three(['\"])#from '${up}build/three.module.js'#" \
    "$JSM/$rel" > "$DEST/examples/jsm/$rel"
done

if grep -rnE "from[[:space:]]*['\"]three['\"]" "$DEST"; then
  echo "bare 'three' imports left in $DEST" >&2
  exit 1
fi
echo "three@$VERSION vendored into ${DEST#"$ROOT_DIR"/}:"
(cd "$DEST" && find . -type f | sort)

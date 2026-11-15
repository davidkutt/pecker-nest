#!/usr/bin/env bash
# Builds the Docker image for headless runs (docker/pi-run.sh) and labels it with the commit it
# contains, so pi-run.sh can refuse an image that is older than the repo.
#
#   scripts/build-image.sh [extra `docker build` arguments]
#
# Labels:
#   nest.commit  the repo's HEAD at build time
#   nest.dirty   1 when the working tree had uncommitted changes (the image then holds more than
#                that commit), else 0
#
# Environment:
#   PI_IMAGE     image name (default: pecker-nest-pi)
#
# The image holds a copy of this repo. Build it again after every change; pi-run.sh stops when the
# image's commit is not the repo's HEAD.
set -euo pipefail

nest_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
image="${PI_IMAGE:-pecker-nest-pi}"

commit="$(git -C "$nest_dir" rev-parse HEAD)"
dirty=0
changes="$(git -C "$nest_dir" status --porcelain)"
if [[ -n "$changes" ]]; then
  dirty=1
  {
    echo "warning: the working tree has uncommitted changes, so the image is labelled nest.dirty=1"
    echo "         and docker/pi-run.sh will refuse it (PI_RUN_ALLOW_STALE_IMAGE=1 overrides)."
    echo "         Commit them, or undo them (Pi writes model switches into agent/settings.json:"
    echo "         git checkout agent/settings.json), then build again."
    echo "$changes" | sed 's/^/           /'
  } >&2
fi

echo "building $image from $nest_dir at ${commit:0:7} (nest.dirty=$dirty)"
docker build -t "$image" -f "$nest_dir/docker/Dockerfile.pi" \
  --label "nest.commit=$commit" --label "nest.dirty=$dirty" "$@" "$nest_dir"
echo "built $image: nest.commit=$commit nest.dirty=$dirty"

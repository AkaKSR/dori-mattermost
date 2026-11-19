#!/usr/bin/env bash
# Adds Mattermost to dori-superagent's Dori mode in ~/.dori/src, installing Dori first when it is missing.
# Usage: git clone https://github.com/AkaKSR/dori-mattermost && bash dori-mattermost/install.sh
#        bash dori-mattermost/install.sh --remove   (takes the add-on out, leaving Dori as it was)
# Run it again to update: it takes the add-on out, updates Dori with Dori's own install.sh, and puts it back.
# Optional env: DORI_SRC (the Dori checkout, default ~/.dori/src).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${DORI_SRC:-$HOME/.dori/src}"
patch="$here/patches/dori-superagent.patch"
dori_install="https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh"

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }

added_files() { (cd "$here/overlay" && find . -type f | sed 's#^\./##' | sort); }

remove_addon() {
  [ -d "$src/.git" ] && git -C "$src" apply --reverse --check "$patch" 2>/dev/null || return 1
  git -C "$src" apply --reverse "$patch"
  added_files | while read -r f; do rm -f "$src/$f"; done
  echo "Mattermost add-on removed from $src"
}

if [ "${1:-}" = "--remove" ]; then
  remove_addon || echo "The Mattermost add-on is not installed in $src; nothing changed."
  exit 0
fi

remove_addon || true

if [ -d "$src/.git" ]; then
  DORI_SRC="$src" bash "$src/install.sh"
else
  curl -fsSL "$dori_install" | DORI_SRC="$src" bash
fi

made_for="$(cut -c1-7 "$here/UPSTREAM")"
at="$(git -C "$src" rev-parse --short HEAD)"
if ! git -C "$src" apply --check "$patch" 2>/dev/null; then
  echo "The add-on was made for Dori $made_for and does not apply to Dori $at in $src; the add-on was not installed." >&2
  exit 1
fi
while read -r f; do
  if [ -e "$src/$f" ]; then
    echo "$src/$f already exists in Dori $at; the add-on was not installed, so nothing of Dori is overwritten." >&2
    exit 1
  fi
done < <(added_files)

git -C "$src" apply "$patch"
cp -R "$here/overlay/." "$src/"
(cd "$src/skills/dori-mode/scripts" && bun install --silent)

echo "Mattermost add-on installed into $src (made for Dori $made_for, Dori is at $at)."
echo "Next: set the DORI_MATTERMOST_* variables and the two hooks (README.md), then run: dori boot"

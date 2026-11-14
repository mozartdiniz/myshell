#!/bin/bash
# Build, install to ~/.local/tessera, run nested (devkit) inside current session.
cd "$(dirname "$0")"
PREFIX="$HOME/.local/tessera"
ninja -C build install >/dev/null || exit 1
export XDG_DATA_DIRS="$PREFIX/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export G_MESSAGES_DEBUG="GNOME Shell"
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${SIZE:-1600x900}"
exec dbus-run-session -- "$PREFIX/bin/gnome-shell" --devkit "$@" 2>&1 | tee /tmp/tessera.log

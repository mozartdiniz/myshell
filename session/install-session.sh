#!/bin/bash
# Build MyShell into ~/.local/myshell and register it as a login session.
#   ./session/install-session.sh            build + install user-side files
#   sudo ./session/install-session.sh --system   install the GDM session entry
set -e
cd "$(dirname "$0")/.."
SESSION_DIR="$PWD/session"

if [ "$1" = "--system" ]; then
    install -Dm644 "$SESSION_DIR/myshell.desktop" /usr/local/share/wayland-sessions/myshell.desktop
    install -Dm644 "$SESSION_DIR/myshell.session" /usr/local/share/gnome-session/sessions/myshell.session
    echo "Installed GDM session entry 'MyShell'."
    exit 0
fi

PREFIX="$HOME/.local/myshell"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

[ -d build ] || meson setup build --prefix="$PREFIX" -Dtests=false -Dgtk_doc=false -Dman=false
ninja -C build install

sed "s|@PREFIX@|$PREFIX|g" "$SESSION_DIR/myshell-launch" > "$PREFIX/bin/myshell-launch"
chmod 755 "$PREFIX/bin/myshell-launch"
install -Dm644 "$SESSION_DIR/gnome-session@myshell.target.conf" \
    "$UNIT_DIR/gnome-session@myshell.target.d/myshell.session.conf"
sed "s|@PREFIX@|$PREFIX|g" "$SESSION_DIR/org.gnome.Shell@myshell.service.conf" \
    | install -Dm644 /dev/stdin "$UNIT_DIR/org.gnome.Shell@myshell.service.d/myshell.conf"
systemctl --user daemon-reload
echo "MyShell installed to $PREFIX."

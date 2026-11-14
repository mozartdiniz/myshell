#!/bin/bash
# Install Tessera on Fedora: the build dependencies, the build itself
# in ~/.local/tessera, and the "Tessera" login session. Run it again
# after a git pull to update. Stock GNOME stays as it is.
#
#   ./install.sh               install or update (asks for sudo)
#   ./install.sh --no-deps     skip installing the build dependencies
#   ./install.sh --uninstall   remove Tessera; ~/.config/tessera stays
set -euo pipefail

SESSION=tessera
MUTTER_MAJOR=51
cd "$(dirname "$(readlink -f "$0")")"
PREFIX=$HOME/.local/$SESSION
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
UNIT_DIR=$CONFIG/systemd/user
WAYLAND_SESSIONS=/usr/local/share/wayland-sessions
GNOME_SESSIONS=/usr/local/share/gnome-session/sessions

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run it as yourself, not as root; it asks for sudo when it needs it"

deps=1
action=install
for arg in "$@"; do
    case $arg in
    --no-deps) deps=0 ;;
    --uninstall) action=uninstall ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
    esac
done

running_from() {
    pgrep -u "$(id -u)" -f "^$1/bin/gnome-shell" >/dev/null
}

check_system() {
    step "Checking the system"
    local id pretty
    # A subshell, as os-release sets NAME and the like
    read -r id pretty < <(. /etc/os-release && echo "${ID:-} ${PRETTY_NAME:-an unknown system}")
    [ "$id" = fedora ] || die "this script is for Fedora; found $pretty"
    command -v gnome-session >/dev/null || die "GNOME isn't installed (no gnome-session)"
    local mutter
    mutter=$(rpm -q --qf '%{VERSION}' mutter 2>/dev/null) || die "mutter isn't installed"
    [ "${mutter%%.*}" = "$MUTTER_MAJOR" ] ||
        die "Tessera is built on GNOME $MUTTER_MAJOR, but this system has mutter $mutter"
    note "$pretty, mutter $mutter"
}

install_deps() {
    step "Installing the build dependencies"
    sudo dnf -y builddep gnome-shell
    # The release tarballs ship CSS, so builddep leaves sassc out
    sudo dnf -y install sassc git meson ninja-build
}

build_prefix() {
    meson introspect build --buildoptions |
        python3 -c 'import json, sys; print(next(o["value"] for o in json.load(sys.stdin) if o["name"] == "prefix"))'
}

build() {
    step "Building into $PREFIX"
    # Subprojects keep the paths of the first setup, so a build for
    # another prefix starts over
    if [ -f build/build.ninja ] && [ "$(build_prefix)" != "$PREFIX" ]; then
        note "build/ was set up for $(build_prefix); starting it over"
        rm -rf build
    fi
    [ -f build/build.ninja ] ||
        meson setup build --prefix="$PREFIX" -Dtests=false -Dgtk_doc=false -Dman=false
    ninja -C build install
}

install_session() {
    step "Registering the Tessera login session"
    sed "s|@PREFIX@|$PREFIX|g" session/$SESSION-launch |
        install -Dm755 /dev/stdin "$PREFIX/bin/$SESSION-launch"
    install -Dm644 session/gnome-session@$SESSION.target.conf \
        "$UNIT_DIR/gnome-session@$SESSION.target.d/$SESSION.conf"
    sed "s|@PREFIX@|$PREFIX|g" session/org.gnome.Shell@$SESSION.service.conf |
        install -Dm644 /dev/stdin "$UNIT_DIR/org.gnome.Shell@$SESSION.service.d/$SESSION.conf"
    systemctl --user daemon-reload
    sudo install -Dm644 session/$SESSION.desktop "$WAYLAND_SESSIONS/$SESSION.desktop"
    sudo install -Dm644 session/$SESSION.session "$GNOME_SESSIONS/$SESSION.session"
}

# Tessera used to be called MyShell
migrate_myshell() {
    local old=myshell
    if [ -d "$CONFIG/$old" ] && [ ! -e "$CONFIG/$SESSION" ]; then
        step "Copying your MyShell settings to $CONFIG/$SESSION"
        cp -a "$CONFIG/$old" "$CONFIG/$SESSION"
    fi
    if [ ! -e "$WAYLAND_SESSIONS/$old.desktop" ] && [ ! -d "$HOME/.local/$old" ] &&
        [ ! -d "$UNIT_DIR/org.gnome.Shell@$old.service.d" ]; then
        return
    fi
    step "Removing MyShell"
    if running_from "$HOME/.local/$old"; then
        note "MyShell is running, so it stays for now: log in to Tessera and run"
        note "./install.sh again to remove it."
        return
    fi
    rm -rf "$UNIT_DIR/gnome-session@$old.target.d" "$UNIT_DIR/org.gnome.Shell@$old.service.d" \
        "$HOME/.local/$old"
    systemctl --user daemon-reload
    sudo rm -f "$WAYLAND_SESSIONS/$old.desktop" "$GNOME_SESSIONS/$old.session"
    note "Done; $CONFIG/$old is left in place."
}

uninstall() {
    step "Removing Tessera"
    running_from "$PREFIX" &&
        note "Tessera is running; it keeps working until you log out."
    rm -rf "$UNIT_DIR/gnome-session@$SESSION.target.d" "$UNIT_DIR/org.gnome.Shell@$SESSION.service.d" \
        "$PREFIX"
    systemctl --user daemon-reload
    sudo rm -f "$WAYLAND_SESSIONS/$SESSION.desktop" "$GNOME_SESSIONS/$SESSION.session"
    note "Removed. Your settings are still in $CONFIG/$SESSION."
}

if [ $action = uninstall ]; then
    uninstall
    exit 0
fi

check_system
# Ask for the password once, up front
sudo -v
[ $deps = 1 ] && install_deps
build
install_session
migrate_myshell

step "Tessera is installed"
note "Log out, click your name on the login screen, pick \"Tessera\" with the"
note "gear button at the bottom right, and log in."
note "To update later: git pull && ./install.sh --no-deps"

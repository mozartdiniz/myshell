# Tessera

A WindowMaker-style desktop for GNOME, built as a fork of GNOME Shell 51.
The top panel and the overview are gone. Instead, every app, applet and
control is a tile that docks to the nearest screen edge, wherever you drop
it. Each tile is one piece of the mosaic: a *tessera*.

It installs next to stock GNOME as its own login session, so you pick it on
the login screen and can always go back.

## What's in it

- **Tiles on every edge.** Drag any tile anywhere; it snaps to the nearest
  edge and keeps its spot. Edges with tiles reserve their space, so
  maximized windows stay clear of them. Pinned and running apps have tiles;
  click to raise or hide an app, and drop files on a tile to open them.
- **Applets**, added from the launcher's Applets tab or the desktop menu:
  System (quick settings, lock, log out), Clock, Date, Timer, Weather,
  Figaro (music), Claude Usage, Claude Agent, Notifications, Caffeine,
  Color Picker, CPU, Memory, Network, Volume, Battery, Workspaces, Folder,
  Eyes, Trash, and the Clip.
- **The Clip**, as in WindowMaker. It switches workspaces (arrows in its
  corners, or scroll) and holds icons per workspace. Its extra:
  - **Click** for Focus mode: every tile outside the Clip slides away and
    gives its space to the windows. It can turn on by itself when a window
    is maximized, and pushing the pointer against an edge peeks at it.
  - **Ctrl+click** for Exposé: the workspace's windows spread out to pick
    one.
  - **Middle-click** collapses its icons; **right-click** for its menu.
- **Launcher** with search on Super (all apps with Super+A), and a
  WindowMaker **root menu** on a right-click on the desktop. A middle-click
  on the desktop, or Super+F11, lists every window.
- **Fixed workspaces**, as in WindowMaker. Stock GNOME keeps its dynamic
  ones.

| Shortcut | |
|---|---|
| Super | Launcher |
| Super+A | All apps |
| Super+S | Quick settings |
| Super+Z | Focus mode |
| Super+E | Exposé |
| Super+F11 | Window list |

## Install

Tessera needs **Fedora with GNOME 51** (Fedora 45).

```sh
git clone https://github.com/mozartdiniz/tessera.git
cd tessera
./install.sh
```

The script installs the build dependencies with dnf, builds Tessera into
`~/.local/tessera` and adds the **Tessera** session to the login screen; it
asks for your password once. Then log out, click your name, pick
**Tessera** with the gear button at the bottom right, and log in.

- **Update:** `git pull && ./install.sh --no-deps`, then log out and in.
- **Uninstall:** `./install.sh --uninstall`. Your settings stay in
  `~/.config/tessera`.

If Tessera doesn't start, log in with GNOME instead and look at its log:
`journalctl --user -b -u org.gnome.Shell@tessera.service`.

## Settings

Everything lives in `~/.config/tessera`: the tile layout (`tiles.json`),
the applets and their settings (`applets.json`), pinned app tiles
(`app-tiles.json`), the Clip (`clip.json`) and the number of workspaces
(`workspaces.json`). Copy the folder to take your desktop to another
machine.

## Hacking

`./run-nested.sh` builds, installs and runs Tessera in a window inside
your current session (`SIZE=1366x768 ./run-nested.sh` for another size).
It needs `sudo dnf install mutter-devkit`, and it shares `~/.local/tessera`
and `~/.config/tessera` with the real session. The tiles are in
`js/ui/dock/`; the applets in `js/ui/dock/docklets/`.

The upstream GNOME Shell README is in
[docs/upstream-README.md](docs/upstream-README.md).

## License

GPL-2.0-or-later, as GNOME Shell; see [COPYING](COPYING).

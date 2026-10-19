#!/bin/bash
# Renders the README media in a throwaway headless GNOME Shell 46.
#
# Your session is not touched: the shell gets its own session bus, dconf, XDG
# dirs and runtime dir; only the PipeWire/Pulse sockets are shared. It runs in
# the plain "user" mode: Ubuntu's mode loads Desktop Icons NG, whose init()
# kills every desktop-icons process of the user, including your session's. The card
# exists only while a Bluetooth headset is connected, but everything it shows
# is replaced by demo states computed with the real estimator.
#
#   tools/media/capture.sh            # screenshots → tools/media/out, media → docs/media
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=$here/out
rm -rf "$out"
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp"/{config,state,cache} "$tmp/data/gnome-shell/extensions"
mkdir -m 700 "$tmp/runtime"
ln -s "$repo/headphones-battery@terentiy" "$here/hp-media@local" "$tmp/data/gnome-shell/extensions/"
for s in pulse pipewire-0; do
    if [ -e "/run/user/$(id -u)/$s" ]; then ln -s "/run/user/$(id -u)/$s" "$tmp/runtime/$s"; fi
done

export XDG_CONFIG_HOME=$tmp/config XDG_DATA_HOME=$tmp/data XDG_STATE_HOME=$tmp/state \
    XDG_CACHE_HOME=$tmp/cache XDG_RUNTIME_DIR=$tmp/runtime HP_MEDIA_OUT=$out
unset DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_SESSION_ID GNOME_SHELL_SESSION_MODE
desktop_icons() { pgrep -f 'ding@rastersoft.com/app/ding.js' || true; }
icons_before=$(desktop_icons)
timeout 120 dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"headphones-battery@terentiy\", \"hp-media@local\"]"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    gsettings set org.gnome.desktop.interface scaling-factor 2
    [ -f "$XDG_CONFIG_HOME/dconf/user" ] || { echo "dconf is not isolated, stopping"; exit 3; }
    exec nice -n 10 gnome-shell --mode=user --headless --no-x11 --virtual-monitor 2560x1600
' 2>&1 | grep -E '\[hp-media\]|JS ERROR|stopping' || true
[ "$(desktop_icons)" = "$icons_before" ] ||
    echo "warning: the desktop icons of your session were restarted during the capture" >&2
[ -f "$out/meta.json" ] || { echo "capture failed"; exit 1; }

gjs -m "$here/compose.js" "$out" "$repo/docs/media"
ffmpeg -loglevel error -y -framerate 30 -i "$out/frames/seq_%04d.png" \
    -c:v libwebp_anim -lossless 0 -q:v 82 -compression_level 6 -loop 0 \
    "$repo/docs/media/demo.webp"
ls -l "$repo/docs/media"

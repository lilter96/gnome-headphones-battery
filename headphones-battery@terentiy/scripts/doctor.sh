#!/usr/bin/env bash
# Read-only, privacy-minimal diagnostics: no radio scan, packets, keys or MACs.
set -euo pipefail
hp_script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "$hp_script_dir/common.sh"
hp_target=$(hp_default_target)
while (($#)); do
    case "$1" in
        --dest)
            (($# >= 2)) || hp_die '--dest requires a path.'
            hp_target=$2; shift 2 ;;
        --help|-h)
            printf 'Usage: bash scripts/doctor.sh [--dest ABSOLUTE_DEST]\nRead-only diagnostics; does not connect to any Bluetooth device.\n'
            exit 0 ;;
        *) hp_die "Unknown argument: $1" ;;
    esac
done
hp_validate_target "$hp_target"
printf 'Headphones Battery diagnostics (no device identifiers collected)\n'
printf 'Installation: %s\n' "$hp_target"
printf 'Session type: %s\n' "${XDG_SESSION_TYPE:-unknown}"
for hp_command in gnome-shell gjs; do
    if command -v "$hp_command" >/dev/null 2>&1; then
        "$hp_command" --version || true
    else
        printf '%s: not installed or not on PATH\n' "$hp_command"
    fi
done
hp_helper="$hp_target/headphones-battery-aap-helper"
if [[ -f "$hp_helper" && -x "$hp_helper" && ! -L "$hp_helper" ]]; then
    "$hp_helper" --version
    if command -v getcap >/dev/null 2>&1; then
        hp_caps=$(getcap -- "$hp_helper")
        if [[ -n "$hp_caps" ]]; then
            printf 'WARNING: helper has file capabilities. This release does not require granting CAP_NET_RAW. Review the installation.\n'
        else
            printf 'Helper capabilities: none (expected)\n'
        fi
    fi
else
    printf 'ERROR: rebuilt helper is missing, non-executable, or a symlink. Run the source installer.\n' >&2
    exit 1
fi
if command -v busctl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    if hp_bluez=$(timeout 3s busctl --system call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus NameHasOwner s org.bluez 2>/dev/null); then
        [[ "$hp_bluez" != 'b true' ]] || printf 'BlueZ owns its system D-Bus name.\n'
        [[ "$hp_bluez" == 'b true' ]] || printf 'WARNING: BlueZ is not running on the system bus.\n'
    else
        printf 'WARNING: system D-Bus is unavailable in this environment.\n'
    fi
fi
printf 'These checks do not verify live battery reception, GNOME rendering, audio continuity, or JBL hardware behavior. Complete the README hardware checklist.\n'

#!/usr/bin/env bash
# Shared path safety for user-level installation tools. No device identifiers,
# Bluetooth keys, or calibration state are read by these scripts.

HP_UUID='headphones-battery@terentiy'

hp_die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

hp_check_command() {
    command -v "$1" >/dev/null 2>&1 || hp_die "Required command not found: $1"
}

hp_validate_absolute_path() {
    local hp_path=$1 hp_part hp_walk=''
    local -a hp_parts
    [[ "$hp_path" == /* ]] || hp_die 'Path must be absolute.'
    [[ "$hp_path" != *$'\n'* && "$hp_path" != *$'\r'* ]] || hp_die 'Control characters in paths are not accepted.'
    [[ "$hp_path" != *'//'* && "$hp_path" != */./* && "$hp_path" != */../* && "$hp_path" != */. && "$hp_path" != */.. ]] || hp_die 'Use an absolute path without dot segments or repeated separators.'
    IFS='/' read -r -a hp_parts <<< "$hp_path"
    for hp_part in "${hp_parts[@]}"; do
        [[ -n "$hp_part" ]] || continue
        hp_walk="$hp_walk/$hp_part"
        [[ ! -L "$hp_walk" ]] || hp_die "Symlink paths are not accepted: $hp_walk"
    done
}

hp_validate_target() {
    local hp_target=$1
    hp_validate_absolute_path "$hp_target"
    [[ "${hp_target##*/}" == "$HP_UUID" ]] || hp_die "Destination basename must be exactly $HP_UUID"
    [[ ! -e "$hp_target" || -d "$hp_target" ]] || hp_die 'Existing destination is not a directory.'
}

hp_default_target() {
    local hp_data=${XDG_DATA_HOME:-${HOME:?HOME is required}/.local/share}
    printf '%s/gnome-shell/extensions/%s\n' "$hp_data" "$HP_UUID"
}

hp_recovery_directory() {
    local hp_parent=${1%/*} hp_outer
    hp_outer=${hp_parent%/*}
    [[ -n "$hp_outer" ]] || hp_outer='/'
    printf '%s/headphones-battery-backups\n' "${hp_outer%/}"
}

hp_validate_metadata() {
    hp_check_command gjs
    gjs -c 'const Gio = imports.gi.Gio; const System = imports.system;
        try {
            const [ok, bytes] = Gio.File.new_for_path(ARGV[0]).load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (!ok || data.uuid !== ARGV[1]) System.exit(1);
        } catch (_) { System.exit(1); }' "$1" "$HP_UUID" || hp_die 'Extension metadata UUID is invalid.'
}

hp_check_install_user() {
    local hp_explicit=$1 hp_target=$2
    if [[ $(id -u) == 0 ]]; then
        # The sole root exception is an explicit isolated /tmp test target.
        # Normal installation never needs sudo or elevated capabilities.
        [[ "$hp_explicit" == 1 && "$hp_target" == /tmp/* ]] || hp_die 'Do not install as root or with sudo. Run as your desktop user.'
    fi
}

hp_lock_parent() {
    local hp_parent=$1 hp_lock
    hp_check_command flock
    hp_lock="$hp_parent/.headphones-battery.install.lock"
    [[ ! -L "$hp_lock" && ( ! -e "$hp_lock" || -f "$hp_lock" ) ]] || hp_die 'Unsafe installer lock path.'
    # Append creates the lock without truncating an existing file. flock is
    # released by the kernel even when this process is killed.
    exec {HP_LOCK_FD}>>"$hp_lock"
    flock -n "$HP_LOCK_FD" || hp_die 'Another install or rollback is running.'
}

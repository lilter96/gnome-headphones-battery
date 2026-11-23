#!/usr/bin/env bash
set -euo pipefail

hp_script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "$hp_script_dir/common.sh"
hp_source_dir=$(CDPATH='' cd -- "$hp_script_dir/.." && pwd -P)
hp_target=$(hp_default_target)
hp_explicit=0

while (($#)); do
    case "$1" in
        --dest)
            (($# >= 2)) || hp_die '--dest requires an absolute destination.'
            hp_target=$2; hp_explicit=1; shift 2 ;;
        --help|-h)
            printf 'Usage: bash scripts/install.sh [--dest /absolute/path/%s]\n' "$HP_UUID"
            printf 'Builds from source, preserves the previous install outside the scanned extensions directory. No sudo, capabilities, or session restart.\n'
            exit 0 ;;
        *) hp_die "Unknown argument: $1" ;;
    esac
done

hp_validate_target "$hp_target"
hp_check_install_user "$hp_explicit" "$hp_target"
hp_parent=${hp_target%/*}
hp_recovery=$(hp_recovery_directory "$hp_target")
hp_validate_absolute_path "$hp_recovery"
if [[ $(id -u) == 0 && "$hp_recovery" != /tmp/* ]]; then
    hp_die 'Root test installation requires an isolated destination and recovery directory beneath /tmp.'
fi
hp_cc=${CC:-gcc}
for hp_command in "$hp_cc" install mktemp mv date stat; do hp_check_command "$hp_command"; done

# An explicit runtime allowlist: never copy the uploaded executable, tests,
# source snapshots, secrets, or user state into the extension.
hp_runtime=(
    extension.js estimator.js presentation.js pet.js ui.js
    bluez.js bluez-monitor.js airpods.js aap-session.js registry.js state-store.js
    stylesheet.css metadata.json
)
for hp_file in "${hp_runtime[@]}" headphones-battery-aap-helper.c; do
    [[ -f "$hp_source_dir/$hp_file" && ! -L "$hp_source_dir/$hp_file" ]] || hp_die "Required regular source file missing: $hp_file"
done
hp_validate_metadata "$hp_source_dir/metadata.json"

mkdir -p -- "$hp_parent" "$hp_recovery"
hp_validate_absolute_path "$hp_parent"
hp_validate_absolute_path "$hp_recovery"
[[ $(stat -c '%d' -- "$hp_parent") == $(stat -c '%d' -- "$hp_recovery") ]] || hp_die 'Destination and recovery directory must be on the same filesystem for atomic renames.'
hp_lock_parent "$hp_parent"
hp_stage=$(mktemp -d -- "$hp_recovery/.headphones-battery.stage.XXXXXXXX")
hp_backup=''
hp_completed=0

hp_finish() {
    local hp_status=$1
    if [[ "$hp_completed" != 1 ]]; then
        if [[ -n "$hp_backup" && -d "$hp_backup" && ! -e "$hp_target" && ! -L "$hp_target" ]]; then
            if mv -T --no-clobber -- "$hp_backup" "$hp_target" && [[ ! -e "$hp_backup" ]]; then
                printf 'Previous installation restored after failure.\n' >&2
            else
                printf 'Restore required; previous installation retained at: %s\n' "$hp_backup" >&2
            fi
        fi
        if [[ -d "$hp_stage" ]]; then
            printf 'Staging directory retained for inspection: %s\n' "$hp_stage" >&2
        fi
    fi
    return "$hp_status"
}
trap 'hp_finish "$?"' EXIT

printf 'Building native AAP helper from source...\n'
if ! "$hp_cc" -std=c11 -O2 -Wall -Wextra -Werror -Wpedantic -Wformat=2 -Wshadow \
    -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now \
    -o "$hp_stage/headphones-battery-aap-helper" "$hp_source_dir/headphones-battery-aap-helper.c"; then
    hp_die 'Build failed. Install GCC and libbluetooth-dev using your normal package workflow; the existing extension was not changed.'
fi
chmod 0755 -- "$hp_stage/headphones-battery-aap-helper"
"$hp_stage/headphones-battery-aap-helper" --version
for hp_file in "${hp_runtime[@]}"; do
    install -m 0644 -- "$hp_source_dir/$hp_file" "$hp_stage/$hp_file"
done
chmod 0755 -- "$hp_stage"

# Validate again after the build. Each rename is atomic on this filesystem.
# The two-name replacement has a brief absent-name window; an EXIT trap
# restores the backup if the second rename fails and no new target appeared.
hp_validate_target "$hp_target"
if [[ -d "$hp_target" ]]; then
    hp_backup=$(mktemp -d -- "$hp_recovery/$HP_UUID.backup.$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
    mv -T -- "$hp_target" "$hp_backup"
fi
mv -T --no-clobber -- "$hp_stage" "$hp_target"
[[ ! -e "$hp_stage" && -d "$hp_target" ]] || hp_die 'Destination appeared during installation; no existing directory was overwritten.'
hp_completed=1

printf 'Installed: %s\n' "$hp_target"
if [[ -n "$hp_backup" ]]; then
    printf 'Backup: %s\n' "$hp_backup"
    printf 'Rollback: bash scripts/rollback.sh --dest %q --backup %q\n' "$hp_target" "$hp_backup"
fi
printf 'Your discharge statistics were not read or modified. No privileges were granted.\n'
printf 'GNOME Shell may still have the previous JavaScript modules loaded. Follow the README reload/smoke-check instructions; no session was restarted.\n'

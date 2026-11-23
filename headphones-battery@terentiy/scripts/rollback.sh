#!/usr/bin/env bash
set -euo pipefail

hp_script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "$hp_script_dir/common.sh"
hp_target=$(hp_default_target)
hp_backup=''
hp_explicit=0
while (($#)); do
    case "$1" in
        --dest)
            (($# >= 2)) || hp_die '--dest requires a path.'
            hp_target=$2; hp_explicit=1; shift 2 ;;
        --backup)
            (($# >= 2)) || hp_die '--backup requires the exact backup path printed by the installer.'
            hp_backup=$2; shift 2 ;;
        --help|-h)
            printf 'Usage: bash scripts/rollback.sh [--dest ABSOLUTE_DEST] --backup ABSOLUTE_BACKUP\n'
            printf 'Restores one exact recovery backup, retaining the current installation as a rollback backup.\n'
            exit 0 ;;
        *) hp_die "Unknown argument: $1" ;;
    esac
done

hp_validate_target "$hp_target"
hp_check_install_user "$hp_explicit" "$hp_target"
[[ -n "$hp_backup" ]] || hp_die 'Specify the exact backup path with --backup.'
hp_validate_absolute_path "$hp_backup"
hp_parent=${hp_target%/*}
hp_recovery=$(hp_recovery_directory "$hp_target")
[[ "${hp_backup%/*}" == "$hp_recovery" ]] || hp_die 'Backup must be in the installation recovery directory.'
hp_backup_name=${hp_backup##*/}
[[ "$hp_backup_name" == "$HP_UUID.backup."* || "$hp_backup_name" == "$HP_UUID.rollback."* ]] || hp_die 'Unrecognized backup name.'
[[ -d "$hp_backup" && -f "$hp_backup/metadata.json" && ! -L "$hp_backup/metadata.json" ]] || hp_die 'Backup is not an extension directory.'
hp_validate_metadata "$hp_backup/metadata.json"
hp_check_command stat
[[ $(stat -c '%d' -- "$hp_parent") == $(stat -c '%d' -- "$hp_recovery") ]] || hp_die 'Backup and destination must be on the same filesystem.'
hp_lock_parent "$hp_parent"

hp_saved=''
hp_completed=0
hp_restore_on_failure() {
    local hp_status=$1
    if [[ "$hp_completed" != 1 && -n "$hp_saved" && -d "$hp_saved" && ! -e "$hp_target" && ! -L "$hp_target" ]]; then
        if ! mv -T --no-clobber -- "$hp_saved" "$hp_target"; then
            printf 'Current installation retained at: %s\n' "$hp_saved" >&2
        fi
    fi
    return "$hp_status"
}
trap 'hp_restore_on_failure "$?"' EXIT

if [[ -d "$hp_target" ]]; then
    hp_saved=$(mktemp -d -- "$hp_recovery/$HP_UUID.rollback.$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
    mv -T -- "$hp_target" "$hp_saved"
fi
mv -T --no-clobber -- "$hp_backup" "$hp_target"
[[ ! -e "$hp_backup" && -d "$hp_target" ]] || hp_die 'Destination appeared during rollback. All versions were retained.'
hp_completed=1
printf 'Restored: %s\n' "$hp_target"
[[ -z "$hp_saved" ]] || printf 'Previous current version retained: %s\n' "$hp_saved"
printf 'No statistics were changed and no GNOME session was restarted.\n'

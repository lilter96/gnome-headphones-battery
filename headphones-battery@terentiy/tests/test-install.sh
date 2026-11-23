#!/usr/bin/env bash
set -euo pipefail
hp_test_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
hp_repo=$(CDPATH='' cd -- "$hp_test_dir/.." && pwd -P)
hp_temp=$(mktemp -d /tmp/headphones-battery-install.XXXXXXXX)
hp_uuid='headphones-battery@terentiy'
hp_dest="$hp_temp/normal/extensions/$hp_uuid"
hp_recovery="$hp_temp/normal/headphones-battery-backups"
hp_count=0
trap 'printf "Installer test fixtures retained at: %s\n" "$hp_temp"' EXIT
ok() { hp_count=$((hp_count + 1)); }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reject() { if "$@" >"$hp_temp/rejected.log" 2>&1; then fail 'unsafe operation unexpectedly succeeded'; fi; ok; }

bash "$hp_repo/scripts/install.sh" --dest "$hp_dest"
[[ -f "$hp_dest/extension.js" && -f "$hp_dest/presentation.js" && -x "$hp_dest/headphones-battery-aap-helper" ]] || fail 'runtime files missing'
ok
[[ ! -e "$hp_dest/headphones-battery-aap-helper.c" && ! -e "$hp_dest/tests" && ! -e "$hp_dest/package.json" ]] || fail 'non-runtime files copied'
ok
"$hp_dest/headphones-battery-aap-helper" --version
ok
printf 'keep me\n' >"$hp_dest/user-sentinel"
mkdir -p -- "$hp_temp/state/headphones-battery"
printf 'calibration sentinel\n' >"$hp_temp/state/headphones-battery/state.json"
XDG_STATE_HOME="$hp_temp/state" bash "$hp_repo/scripts/install.sh" --dest "$hp_dest"
hp_backups=("$hp_recovery/$hp_uuid.backup."*)
[[ ${#hp_backups[@]} == 1 && -f "${hp_backups[0]}/user-sentinel" ]] || fail 'old install not preserved'
ok
[[ ! -e "$hp_dest/user-sentinel" ]] || fail 'old unknown files leaked into new runtime'
ok
[[ $(<"$hp_temp/state/headphones-battery/state.json") == 'calibration sentinel' ]] || fail 'calibration was touched'
ok
bash "$hp_repo/scripts/rollback.sh" --dest "$hp_dest" --backup "${hp_backups[0]}"
[[ -f "$hp_dest/user-sentinel" && ! -e "${hp_backups[0]}" ]] || fail 'rollback did not restore exact backup'
ok
hp_rollbacks=("$hp_recovery/$hp_uuid.rollback."*)
[[ ${#hp_rollbacks[@]} == 1 && -f "${hp_rollbacks[0]}/extension.js" ]] || fail 'rollback discarded current version'
ok

reject env CC=false bash "$hp_repo/scripts/install.sh" --dest "$hp_dest"
[[ -f "$hp_dest/user-sentinel" ]] || fail 'build failure changed existing installation'
ok

# Inject failure only for the final stage->target rename. The installer must
# restore the old directory automatically, without deleting either version.
HP_TEST_REAL_MV=$(command -v mv)
export HP_TEST_REAL_MV
# This exported function is invoked by the installer child shell, not locally.
# shellcheck disable=SC2317
mv() {
    local hp_source=${*: -2:1}
    if [[ "$hp_source" == */.headphones-battery.stage.* ]]; then
        return 73
    fi
    "$HP_TEST_REAL_MV" "$@"
}
export -f mv
reject bash "$hp_repo/scripts/install.sh" --dest "$hp_dest"
unset -f mv
[[ $(<"$hp_temp/rejected.log") == *'Previous installation restored after failure.'* ]] || fail 'injected rename failure was not exercised'
ok
[[ -f "$hp_dest/user-sentinel" ]] || fail 'rename failure did not restore the old installation'
ok

reject bash "$hp_repo/scripts/install.sh" --dest "$hp_temp/wrong-name"
reject bash "$hp_repo/scripts/install.sh" --dest /tmp
reject bash "$hp_repo/scripts/install.sh" --dest "relative/$hp_uuid"
reject bash "$hp_repo/scripts/install.sh" --dest "$hp_temp/../$hp_uuid"
mkdir -p -- "$hp_temp/linked" "$hp_temp/actual"
ln -s -- "$hp_temp/actual" "$hp_temp/linked/$hp_uuid"
reject bash "$hp_repo/scripts/install.sh" --dest "$hp_temp/linked/$hp_uuid"
ln -s -- "$hp_temp/actual" "$hp_temp/symlink-parent"
reject bash "$hp_repo/scripts/install.sh" --dest "$hp_temp/symlink-parent/$hp_uuid"
reject bash "$hp_repo/scripts/rollback.sh" --dest "$hp_dest" --backup "$hp_temp/actual"
reject bash "$hp_repo/scripts/rollback.sh" --dest "$hp_dest" --backup "$hp_recovery/$hp_uuid.backup.does-not-exist"
mkdir -p -- "$hp_recovery/$hp_uuid.backup.invalid-metadata"
printf '{"uuid":"another-extension"}\n' >"$hp_recovery/$hp_uuid.backup.invalid-metadata/metadata.json"
reject bash "$hp_repo/scripts/rollback.sh" --dest "$hp_dest" --backup "$hp_recovery/$hp_uuid.backup.invalid-metadata"
[[ -f "$hp_dest/user-sentinel" ]] || fail 'invalid backup changed current installation'
ok
hp_spaced="$hp_temp/with spaces/extensions/$hp_uuid"
bash "$hp_repo/scripts/install.sh" --dest "$hp_spaced"
[[ -f "$hp_spaced/extension.js" && -x "$hp_spaced/headphones-battery-aap-helper" ]] || fail 'quoted destination path was not handled'
ok
if [[ $(id -u) == 0 ]]; then
    reject env XDG_DATA_HOME="$hp_temp/root-default" bash "$hp_repo/scripts/install.sh"
    [[ ! -e "$hp_temp/root-default" ]] || fail 'root default created directories'
    ok
fi
bash "$hp_repo/scripts/doctor.sh" --dest "$hp_dest"
ok
printf 'Installer/rollback: %s checks passed; no user installation or real state touched.\n' "$hp_count"

#!/usr/bin/gjs -m
// Synthetic IPC fixture. This file never opens a Bluetooth socket.
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

const args = [...ARGV];
if (args.shift() !== '--watch')
    System.exit(64);
if (args[0] === '--adapter') {
    args.shift();
    if (args.shift() !== '11:22:33:44:55:66')
        System.exit(64);
}
if (args.length !== 1)
    System.exit(64);
const address = args[0];
const mode = Number.parseInt(address.slice(-2), 16);
const packet = {
    version: 1, type: 'battery', address,
    left: 57, right: 93, case: null,
    charging: {left: false, right: false, case: null},
    status: {left: 'discharging', right: 'discharging', case: 'disconnected'},
    present: ['left', 'right', 'case'],
    source: 'aap', updated_at: 1793538071,
};
const loop = new GLib.MainLoop(null, false);
const emit = () => print(JSON.stringify(packet));
const later = (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    callback();
    return GLib.SOURCE_REMOVE;
});
const output = new GioUnix.OutputStream({fd: 1, close_fd: false});

switch (mode) {
case 1:
    emit();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        emit();
        return GLib.SOURCE_CONTINUE;
    });
    break;
case 2:
    emit();
    System.exit(0);
    break;
case 3:
    print('{not json}');
    break;
case 4:
    packet.address = '00:00:00:00:00:FF';
    emit();
    break;
case 5:
    print('x'.repeat(32768));
    break;
case 6:
    System.exit(77);
    break;
case 7:
    // Stay alive without a single byte of telemetry.
    break;
case 8:
    emit();
    break;
case 9:
    output.write_all(new Uint8Array([255, 254, 10]), null);
    break;
case 10: {
    const json = JSON.stringify(packet);
    output.write_all(new TextEncoder().encode(json.slice(0, 37)), null);
    later(30, () => output.write_all(new TextEncoder().encode(`${json.slice(37)}\n`), null));
    break;
}
case 11:
    printerr('private-diagnostic-'.repeat(10000));
    break;
case 12:
    later(20, () => System.exit(69));
    break;
case 13:
    packet.address = address.toLowerCase();
    emit();
    break;
case 14:
    for (let i = 0; i < 300; i++)
        emit();
    break;
case 15:
    output.write_all(new TextEncoder().encode(JSON.stringify(packet)), null);
    System.exit(0);
    break;
case 16:
    emit();
    later(30, () => print('invalid-next-frame'));
    break;
case 17:
    emit();
    later(30, () => System.exit(77));
    break;
default:
    System.exit(64);
}

loop.run();

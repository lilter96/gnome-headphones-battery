/*
 * Read-only AirPods battery client, AAP over Linux BR/EDR L2CAP PSM 0x1001.
 *
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror -o
 *        headphones-battery-aap-helper headphones-battery-aap-helper.c
 * Requires the BlueZ development headers (libbluetooth-dev), not libbluetooth
 * at runtime. Run as the logged-in user: SOCK_SEQPACKET does not require the
 * CAP_NET_RAW capability that Linux requires for SOCK_RAW. Do not setcap it.
 *
 * Usage: headphones-battery-aap-helper [--watch|--once]
 *                                   [--adapter LOCAL_MAC] REMOTE_MAC
 * MAC alone retains the old one-shot invocation. --watch keeps ONE connection;
 * the caller owns process lifetime and reconnection/backoff. stdout is NDJSON
 * protocol version 1, stderr is a short diagnostic without device addresses.
 *
 * Wire facts verified against the following primary implementations. This is
 * an independent C implementation, not a copied upstream client:
 * https://github.com/Rockykln/podctl/blob/main/src/aap.rs
 * https://github.com/mstroecker/LinuxPods/blob/main/src/aap/battery.rs
 * https://github.com/mstroecker/LinuxPods/blob/main/src/aap/client.rs
 * The only outgoing messages are the handshake and notification subscription;
 * no noise-control, feature-setting or key-retrieval commands are sent.
 */

#define _POSIX_C_SOURCE 200809L

#include <bluetooth/bluetooth.h>
#include <bluetooth/l2cap.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define HELPER_VERSION "3.0.0"
#define AAP_PSM 0x1001
#define PACKET_CAPACITY 4096
#define JSON_CAPACITY 1024
#define CONNECT_TIMEOUT_MS 45000
#define SEND_TIMEOUT_MS 2000

static const uint8_t HANDSHAKE[] = {
    0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};
static const uint8_t HANDSHAKE_REPLY[] = {0x01, 0x00, 0x04, 0x00};
static const uint8_t BATTERY_HEADER[] = {0x04, 0x00, 0x04, 0x00, 0x04, 0x00};
static const uint8_t SUBSCRIBE[] = {
    0x04, 0x00, 0x04, 0x00, 0x0f, 0x00, 0xff, 0xff, 0xff, 0xff
};

enum component { LEFT, RIGHT, CASE, COMPONENT_COUNT };
enum battery_status { UNKNOWN = 0, CHARGING = 1, DISCHARGING = 2, DISCONNECTED = 4 };
enum parse_result { MALFORMED = -1, UNRELATED = 0, BATTERY = 1 };

struct battery_component {
    bool present;
    int level; /* -1 means unavailable, never a wire percentage. */
    enum battery_status status;
};

struct battery_snapshot {
    struct battery_component components[COMPONENT_COUNT];
};

/* Explicit arguments let socketpair tests exercise deadlines without adding
 * production environment-variable overrides or a mock-socket CLI backdoor. */
struct session_limits {
    int handshake_ms;
    int initial_battery_ms;
    int refresh_ms;
    int silent_ms;
};

static const struct session_limits DEFAULT_LIMITS = {5000, 10000, 60000, 180000};
static volatile sig_atomic_t stopping;

static void on_signal(int signal_number)
{
    (void)signal_number;
    stopping = 1;
}

static int install_signals(void)
{
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_signal;
    if (sigemptyset(&action.sa_mask) < 0 ||
        sigaction(SIGTERM, &action, NULL) < 0 ||
        sigaction(SIGINT, &action, NULL) < 0)
        return -1;
    action.sa_handler = SIG_IGN;
    return sigaction(SIGPIPE, &action, NULL);
}

static int hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool parse_mac(const char *text, bdaddr_t *address, char canonical[18])
{
    static const char HEX[] = "0123456789ABCDEF";
    bdaddr_t parsed;
    char normalized[18];
    if (!text || strlen(text) != 17) return false;
    for (size_t i = 0; i < 6; ++i) {
        const size_t pos = i * 3;
        const int hi = hex_digit(text[pos]);
        const int lo = hex_digit(text[pos + 1]);
        if (hi < 0 || lo < 0 || (i < 5 && text[pos + 2] != ':')) return false;
        parsed.b[5 - i] = (uint8_t)((hi << 4) | lo);
        normalized[pos] = HEX[hi];
        normalized[pos + 1] = HEX[lo];
        if (i < 5) normalized[pos + 2] = ':';
    }
    normalized[17] = '\0';
    *address = parsed;
    memcpy(canonical, normalized, sizeof(normalized));
    return true;
}

/* A SOCK_SEQPACKET read must contain exactly one complete notification.
 * Parse into a temporary object: a bad final record must not apply the earlier
 * records. The reserved marker bytes are part of the currently verified
 * layout; reject new layouts rather than guessing that arbitrary bytes are %.
 */
static enum parse_result parse_battery(const uint8_t *data, size_t length,
                                      struct battery_snapshot *output)
{
    if (!data || length < sizeof(BATTERY_HEADER) ||
        memcmp(data, BATTERY_HEADER, sizeof(BATTERY_HEADER)) != 0)
        return UNRELATED;
    if (length < 7) return MALFORMED;
    const size_t count = data[6];
    if (!count || length != 7 + count * 5) return MALFORMED;

    struct battery_snapshot parsed = {0};
    bool seen[256] = {false};
    bool any_known = false;
    for (size_t i = 0; i < COMPONENT_COUNT; ++i)
        parsed.components[i].level = -1;

    for (size_t i = 0; i < count; ++i) {
        const size_t off = 7 + i * 5;
        const uint8_t kind = data[off];
        const uint8_t level = data[off + 2];
        const uint8_t status = data[off + 3];
        if (seen[kind] || data[off + 1] != 1 || data[off + 4] != 1)
            return MALFORMED;
        seen[kind] = true;
        if (status != UNKNOWN && status != CHARGING &&
            status != DISCHARGING && status != DISCONNECTED)
            return MALFORMED;
        int index;
        switch (kind) {
        case 0x04: index = LEFT; break;
        case 0x02: index = RIGHT; break;
        case 0x08: index = CASE; break;
        default: continue; /* An unrecognised physical component has no label. */
        }
        struct battery_component *component = &parsed.components[index];
        component->present = true;
        component->status = (enum battery_status)status;
        if (level <= 100 && (status == CHARGING || status == DISCHARGING))
            component->level = level; /* Includes a genuine, connected 0%. */
        any_known = true;
    }
    if (!any_known) return UNRELATED;
    *output = parsed;
    return BATTERY;
}

static const char *status_json(const struct battery_component *component)
{
    if (!component->present) return "null";
    switch (component->status) {
    case CHARGING: return "\"charging\"";
    case DISCHARGING: return "\"discharging\"";
    case DISCONNECTED: return "\"disconnected\"";
    case UNKNOWN: return "\"unknown\"";
    }
    return "null";
}

static const char *charging_json(const struct battery_component *component)
{
    if (!component->present) return "null";
    if (component->status == CHARGING) return "true";
    if (component->status == DISCHARGING) return "false";
    return "null";
}

static int format_snapshot(char *line, size_t capacity, const char *address,
                           const struct battery_snapshot *snapshot, int64_t timestamp)
{
    static const char *const names[] = {"left", "right", "case"};
    char levels[COMPONENT_COUNT][16];
    char present[64] = "";
    size_t present_length = 0;
    for (size_t i = 0; i < COMPONENT_COUNT; ++i) {
        const struct battery_component *component = &snapshot->components[i];
        if (component->level < 0)
            memcpy(levels[i], "null", 5);
        else
            (void)snprintf(levels[i], sizeof(levels[i]), "%d", component->level);
        if (component->present) {
            int n = snprintf(present + present_length, sizeof(present) - present_length,
                             "%s\"%s\"", present_length ? "," : "", names[i]);
            if (n < 0 || (size_t)n >= sizeof(present) - present_length) {
                errno = EOVERFLOW;
                return -1;
            }
            present_length += (size_t)n;
        }
    }
    int n = snprintf(line, capacity,
        "{\"version\":1,\"type\":\"battery\",\"address\":\"%s\","
        "\"present\":[%s],\"left\":%s,\"right\":%s,\"case\":%s,"
        "\"charging\":{\"left\":%s,\"right\":%s,\"case\":%s},"
        "\"status\":{\"left\":%s,\"right\":%s,\"case\":%s},"
        "\"source\":\"aap\",\"updated_at\":%" PRId64 "}\n",
        address, present, levels[LEFT], levels[RIGHT], levels[CASE],
        charging_json(&snapshot->components[LEFT]),
        charging_json(&snapshot->components[RIGHT]),
        charging_json(&snapshot->components[CASE]),
        status_json(&snapshot->components[LEFT]),
        status_json(&snapshot->components[RIGHT]),
        status_json(&snapshot->components[CASE]), timestamp);
    if (n < 0 || (size_t)n >= capacity) {
        errno = EOVERFLOW;
        return -1;
    }
    return n;
}

static int64_t monotonic_ms(void)
{
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int64_t deadline_after(int timeout_ms)
{
    int64_t now = monotonic_ms();
    return now < 0 ? -1 : now + timeout_ms;
}

/* Returns revents, 0 for a timeout, -1 for an error. HUP+POLLIN is deliberately
 * passed to recv: a final complete packet can precede EOF. */
static int wait_fd(int fd, short events, int64_t deadline)
{
    for (;;) {
        if (stopping) { errno = ECANCELED; return -1; }
        int64_t now = monotonic_ms();
        if (now < 0) return -1;
        int64_t remaining = deadline - now;
        if (remaining <= 0) { errno = ETIMEDOUT; return 0; }
        struct pollfd polled = {.fd = fd, .events = events};
        int rc = poll(&polled, 1, remaining > INT_MAX ? INT_MAX : (int)remaining);
        if (rc < 0 && errno == EINTR) continue;
        if (rc < 0) return -1;
        if (!rc) continue; /* Account for clock granularity against the deadline. */
        if (polled.revents & POLLNVAL) { errno = EBADF; return -1; }
        if (polled.revents & (events | POLLHUP | POLLERR)) return polled.revents;
    }
}

/* One full seqpacket or an error. A zero-length message is not an AAP packet
 * and is treated as EOF. MSG_TRUNC prevents accepting a valid-looking prefix
 * from an oversized notification. errno distinguishes timeout from EOF. */
static int receive_packet(int fd, uint8_t *buffer, size_t capacity, size_t *length,
                          int64_t deadline)
{
    for (;;) {
        const int events = wait_fd(fd, POLLIN, deadline);
        if (events <= 0) return -1;
        struct iovec iov = {.iov_base = buffer, .iov_len = capacity};
        struct msghdr message = {0};
        message.msg_iov = &iov;
        message.msg_iovlen = 1;
        ssize_t n = recvmsg(fd, &message, MSG_DONTWAIT | MSG_TRUNC);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (events & (POLLHUP | POLLERR)) { errno = ECONNRESET; return -1; }
            continue;
        }
        if (n < 0) return -1;
        if (!n) { errno = ECONNRESET; return -1; }
        if ((message.msg_flags & MSG_TRUNC) || (size_t)n > capacity) {
            errno = EMSGSIZE;
            return -1;
        }
        *length = (size_t)n;
        return 0;
    }
}

static int send_packet(int fd, const uint8_t *packet, size_t length, int64_t deadline)
{
    for (;;) {
        if (stopping) { errno = ECANCELED; return -1; }
        ssize_t n = send(fd, packet, length, MSG_DONTWAIT | MSG_NOSIGNAL);
        if (n >= 0) {
            if ((size_t)n == length) return 0;
            errno = EPROTO; /* Never split one seqpacket across multiple sends. */
            return -1;
        }
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
        if (wait_fd(fd, POLLOUT, deadline) <= 0) return -1;
    }
}

static int make_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int restore_nonblocking(int fd, int saved_flags)
{
    /* File-status flags belong to the open-file description: dup() alone
     * would still change a CLI caller's inherited stdout. Restore only the
     * bit we changed, preserving unrelated changes made by another owner. */
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, (flags & ~O_NONBLOCK) | (saved_flags & O_NONBLOCK));
}

static int write_output(int fd, const char *line, size_t length, int64_t deadline)
{
    size_t offset = 0;
    while (offset < length) {
        if (stopping) { errno = ECANCELED; return -1; }
        ssize_t n = write(fd, line + offset, length - offset);
        if (n > 0) { offset += (size_t)n; continue; }
        if (n == 0) { errno = EIO; return -1; }
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
        if (wait_fd(fd, POLLOUT, deadline) <= 0) return -1;
    }
    return 0;
}

static int emit_snapshot(int output, const char *address,
                         const struct battery_snapshot *snapshot)
{
    struct timespec real;
    if (clock_gettime(CLOCK_REALTIME, &real) < 0) return -1;
    char line[JSON_CAPACITY];
    int length = format_snapshot(line, sizeof(line), address, snapshot, real.tv_sec);
    if (length < 0) return -1;
    int64_t deadline = deadline_after(SEND_TIMEOUT_MS);
    if (deadline < 0) return -1;
    return write_output(output, line, (size_t)length, deadline);
}

static int run_session(int fd, int output, const char *address, bool watch,
                       const struct session_limits *limits)
{
    int64_t deadline = deadline_after(limits->handshake_ms);
    if (deadline < 0 || send_packet(fd, HANDSHAKE, sizeof(HANDSHAKE), deadline) < 0)
        return -1;

    uint8_t buffer[PACKET_CAPACITY];
    size_t length;
    for (;;) {
        if (receive_packet(fd, buffer, sizeof(buffer), &length, deadline) < 0) {
            if (errno == EMSGSIZE) continue;
            return -1;
        }
        if (length >= sizeof(HANDSHAKE_REPLY) &&
            memcmp(buffer, HANDSHAKE_REPLY, sizeof(HANDSHAKE_REPLY)) == 0)
            break;
    }
    deadline = deadline_after(SEND_TIMEOUT_MS);
    if (deadline < 0 || send_packet(fd, SUBSCRIBE, sizeof(SUBSCRIBE), deadline) < 0)
        return -1;

    int64_t now = monotonic_ms();
    if (now < 0) return -1;
    int64_t battery_deadline = now + limits->initial_battery_ms;
    int64_t refresh_at = now + limits->refresh_ms;
    for (;;) {
        now = monotonic_ms();
        if (now < 0) return -1;
        if (now >= battery_deadline) { errno = ETIMEDOUT; return -1; }
        if (watch && now >= refresh_at) {
            /* Refresh the read-only subscription on this connection. Unlike
             * relaunching a helper, this does not open a new L2CAP channel.
             * Only a battery response renews the no-battery watchdog. */
            if (send_packet(fd, SUBSCRIBE, sizeof(SUBSCRIBE), now + SEND_TIMEOUT_MS) < 0)
                return -1;
            refresh_at = now + limits->refresh_ms;
        }
        deadline = battery_deadline;
        if (watch && refresh_at < deadline) deadline = refresh_at;
        if (receive_packet(fd, buffer, sizeof(buffer), &length, deadline) < 0) {
            if (errno == EMSGSIZE || errno == ETIMEDOUT) continue;
            return -1;
        }
        struct battery_snapshot snapshot;
        if (parse_battery(buffer, length, &snapshot) != BATTERY) continue;
        if (emit_snapshot(output, address, &snapshot) < 0) return -1;
        if (!watch) return 0;
        now = monotonic_ms();
        if (now < 0) return -1;
        battery_deadline = now + limits->silent_ms;
    }
}

/* L2CAP can report POLLOUT while its channel still connects. CONNINFO succeeds
 * only once BT_CONNECTED; SO_ERROR alone is not a connection-ready check. */
static int channel_state(int fd)
{
    struct l2cap_conninfo info = {0};
    socklen_t length = sizeof(info);
    if (getsockopt(fd, SOL_L2CAP, L2CAP_CONNINFO, &info, &length) == 0)
        return 1;
    if (errno != ENOTCONN) return -1;

    int error = 0;
    length = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0) return -1;
    if (error) { errno = error; return -1; }
    struct sockaddr_l2 peer = {0};
    length = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &length) == 0)
        return 0;
    return -1;
}

static int connect_aap(const bdaddr_t *remote, const bdaddr_t *local)
{
    int fd = socket(AF_BLUETOOTH, SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC,
                    BTPROTO_L2CAP);
    if (fd < 0) return -1;

    const struct bt_security security = {.level = BT_SECURITY_MEDIUM, .key_size = 0};
    if (setsockopt(fd, SOL_BLUETOOTH, BT_SECURITY, &security, sizeof(security)) < 0)
        goto fail;
    if (local) {
        struct sockaddr_l2 address = {0};
        address.l2_family = AF_BLUETOOTH;
        address.l2_bdaddr = *local;
        address.l2_bdaddr_type = BDADDR_BREDR;
        /* PSM 0 lets the kernel choose an ephemeral local channel. */
        if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0) goto fail;
    }
    struct sockaddr_l2 address = {0};
    address.l2_family = AF_BLUETOOTH;
    address.l2_psm = htobs(AAP_PSM);
    address.l2_bdaddr = *remote;
    address.l2_bdaddr_type = BDADDR_BREDR;
    int rc = connect(fd, (struct sockaddr *)&address, sizeof(address));
    if (rc < 0 && errno != EINPROGRESS && errno != EALREADY && errno != EWOULDBLOCK)
        goto fail;

    const int64_t deadline = deadline_after(CONNECT_TIMEOUT_MS);
    if (deadline < 0) goto fail;
    for (;;) {
        if (stopping) { errno = ECANCELED; goto fail; }
        rc = channel_state(fd);
        if (rc > 0) return fd;
        if (rc < 0) goto fail;
        int64_t now = monotonic_ms();
        if (now < 0) goto fail;
        if (now >= deadline) { errno = ETIMEDOUT; goto fail; }
        /* Do not busy-spin on premature POLLOUT. Error/HUP still wake us. */
        struct pollfd polled = {.fd = fd, .events = 0};
        int delay = deadline - now < 50 ? (int)(deadline - now) : 50;
        rc = poll(&polled, 1, delay);
        if (rc < 0 && errno != EINTR) goto fail;
        if (rc > 0 && (polled.revents & POLLNVAL)) { errno = EBADF; goto fail; }
        if (rc > 0 && (polled.revents & (POLLERR | POLLHUP))) {
            int error = 0;
            socklen_t length = sizeof(error);
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0) goto fail;
            errno = error ? error : ECONNRESET;
            goto fail;
        }
    }

fail: {
        const int saved = errno;
        (void)shutdown(fd, SHUT_RDWR);
        (void)close(fd);
        errno = saved;
        return -1;
    }
}

static int report_error(const char *stage)
{
    const int error = errno;
    if (stopping || error == ECANCELED) return 0;
    fprintf(stderr, "aap-helper: %s: %s\n", stage, strerror(error));
    return error == EACCES || error == EPERM ? 77 : 69;
}

static void usage(FILE *stream)
{
    fputs("Usage: headphones-battery-aap-helper [--watch|--once] "
          "[--adapter LOCAL_MAC] REMOTE_MAC\n"
          "       headphones-battery-aap-helper --version\n", stream);
}

int main(int argc, char **argv)
{
    bool watch = false;
    bool mode_given = false;
    bool has_local = false;
    bool has_remote = false;
    bdaddr_t remote, local;
    char canonical[18], local_name[18];
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("headphones-battery-aap-helper " HELPER_VERSION " (protocol 1)");
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--help") == 0) { usage(stdout); return 0; }
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--watch") || !strcmp(argv[i], "--once")) {
            if (mode_given) goto invalid;
            mode_given = true;
            watch = !strcmp(argv[i], "--watch");
        } else if (!strcmp(argv[i], "--adapter")) {
            if (has_local || ++i >= argc || !parse_mac(argv[i], &local, local_name))
                goto invalid;
            has_local = true;
        } else {
            if (has_remote || !parse_mac(argv[i], &remote, canonical)) goto invalid;
            has_remote = true;
        }
    }
    if (!has_remote) goto invalid;
    if (getuid() != geteuid() || getgid() != getegid()) {
        fputs("aap-helper: setuid/setgid execution is not supported\n", stderr);
        return 77;
    }
    stopping = 0;
    if (install_signals() < 0)
        return report_error("initialization");
    int stdout_flags = fcntl(STDOUT_FILENO, F_GETFL);
    if (stdout_flags < 0 || make_nonblocking(STDOUT_FILENO) < 0)
        return report_error("stdout initialization");

    int fd = connect_aap(&remote, has_local ? &local : NULL);
    int result;
    if (fd < 0) {
        result = report_error("connection");
    } else {
        int rc = run_session(fd, STDOUT_FILENO, canonical, watch, &DEFAULT_LIMITS);
        int saved = errno;
        (void)shutdown(fd, SHUT_RDWR);
        (void)close(fd);
        errno = saved;
        result = rc < 0 ? report_error("session") : 0;
    }
    /* This also runs after cooperative SIGTERM and connection errors. A
     * supervisor's pipe has no parent writer; CLI invocation may share one. */
    if (restore_nonblocking(STDOUT_FILENO, stdout_flags) < 0 && result == 0)
        result = report_error("stdout restoration");
    return result;

invalid:
    usage(stderr);
    return 64;
}

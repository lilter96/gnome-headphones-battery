/* Native AAP parser/transport regression tests. No Bluetooth hardware needed.
 * The wire example below is a DOCUMENTED UPSTREAM EXAMPLE, not a capture from
 * this machine: LinuxPods src/aap/battery.rs (LibrePods AAP definitions).
 * Other packets are explicitly synthetic mutations or constructed fixtures.
 */
#define main hp_helper_program_main
#include "../headphones-battery-aap-helper.c"
#undef main

#include <sys/wait.h>

static unsigned assertions;
#define CHECK(condition) do { \
    ++assertions; \
    if (!(condition)) { \
        fprintf(stderr, "FAIL %s:%d: %s (errno=%d)\n", __FILE__, __LINE__, #condition, errno); \
        exit(1); \
    } \
} while (0)

static const uint8_t DOCUMENTED_EXAMPLE[] = {
    0x04, 0x00, 0x04, 0x00, 0x04, 0x00, 0x03,
    0x02, 0x01, 0x64, 0x02, 0x01,
    0x04, 0x01, 0x63, 0x01, 0x01,
    0x08, 0x01, 0x11, 0x02, 0x01,
};
static const char TEST_MAC[] = "AA:BB:CC:DD:EE:FF";

static void test_mac(void)
{
    bdaddr_t address;
    char canonical[18];
    CHECK(parse_mac("aa:BB:0c:DD:ee:12", &address, canonical));
    CHECK(!strcmp(canonical, "AA:BB:0C:DD:EE:12"));
    CHECK(address.b[0] == 0x12 && address.b[5] == 0xaa && address.b[3] == 0x0c);
    const char *const invalid[] = {
        "", "AA:BB:CC:DD:EE", "AA:BB:CC:DD:EE:FFF", "AA:BB:CC:DD:EE:FG",
        "AA:BB:CC:DD:EE:FFx", " AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FF ",
        "AA-BB-CC-DD-EE-FF", "A:B:C:D:E:F", "1AA:BB:CC:DD:EE:FF",
        "AA:BB:CC:DD:EE:+F", "AA:BB:CC:DD:EE:-F", "AA:BB:CC:DD:EE:FF\n",
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i)
        CHECK(!parse_mac(invalid[i], &address, canonical));
    CHECK(!parse_mac(NULL, &address, canonical));
}

static void test_parser(void)
{
    struct battery_snapshot snapshot;
    CHECK(parse_battery(DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == BATTERY);
    CHECK(snapshot.components[LEFT].level == 99);
    CHECK(snapshot.components[LEFT].status == CHARGING);
    CHECK(snapshot.components[RIGHT].level == 100);
    CHECK(snapshot.components[RIGHT].status == DISCHARGING);
    CHECK(snapshot.components[CASE].level == 17);
    for (size_t i = 0; i < COMPONENT_COUNT; ++i) CHECK(snapshot.components[i].present);

    uint8_t one[] = {4, 0, 4, 0, 4, 0, 1, 4, 1, 0, 2, 1};
    CHECK(parse_battery(one, sizeof(one), &snapshot) == BATTERY);
    CHECK(snapshot.components[LEFT].level == 0); /* Real zero, not missing. */
    CHECK(!snapshot.components[RIGHT].present && snapshot.components[RIGHT].level == -1);
    CHECK(!snapshot.components[CASE].present && snapshot.components[CASE].level == -1);
    for (unsigned level = 0; level < 256; ++level) {
        one[9] = (uint8_t)level;
        one[10] = DISCHARGING;
        CHECK(parse_battery(one, sizeof(one), &snapshot) == BATTERY);
        CHECK(snapshot.components[LEFT].level == (level <= 100 ? (int)level : -1));
        one[10] = DISCONNECTED;
        CHECK(parse_battery(one, sizeof(one), &snapshot) == BATTERY);
        CHECK(snapshot.components[LEFT].level == -1);
        CHECK(!strcmp(charging_json(&snapshot.components[LEFT]), "null"));
        one[10] = UNKNOWN;
        CHECK(parse_battery(one, sizeof(one), &snapshot) == BATTERY);
        CHECK(snapshot.components[LEFT].level == -1);
    }
    for (unsigned status = 0; status < 256; ++status) {
        one[10] = (uint8_t)status;
        const bool valid = status == UNKNOWN || status == CHARGING ||
                           status == DISCHARGING || status == DISCONNECTED;
        CHECK((parse_battery(one, sizeof(one), &snapshot) == BATTERY) == valid);
    }

    struct battery_snapshot untouched;
    memset(&untouched, 0x5a, sizeof(untouched));
    for (size_t length = 0; length < sizeof(DOCUMENTED_EXAMPLE); ++length) {
        snapshot = untouched;
        CHECK(parse_battery(DOCUMENTED_EXAMPLE, length, &snapshot) != BATTERY);
        CHECK(!memcmp(&snapshot, &untouched, sizeof(snapshot)));
    }
    CHECK(parse_battery(NULL, 0, &snapshot) == UNRELATED);
    uint8_t bad[sizeof(DOCUMENTED_EXAMPLE) + 1];
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[sizeof(DOCUMENTED_EXAMPLE)] = 0;
    CHECK(parse_battery(bad, sizeof(bad), &snapshot) == MALFORMED);
    for (unsigned count = 0; count < 256; ++count) {
        bad[6] = (uint8_t)count;
        CHECK((parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == BATTERY) == (count == 3));
    }
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[12] = bad[7]; /* Duplicate right component. */
    CHECK(parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == MALFORMED);
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[8] = 0; /* Invalid marker. */
    CHECK(parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == MALFORMED);
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[21] = 0; /* Invalid final marker must reject ALL records. */
    snapshot = untouched;
    CHECK(parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == MALFORMED);
    CHECK(!memcmp(&snapshot, &untouched, sizeof(snapshot)));
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[0] = 1;
    CHECK(parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == UNRELATED);

    one[7] = 0x7f; one[10] = DISCHARGING;
    CHECK(parse_battery(one, sizeof(one), &snapshot) == UNRELATED);
    memcpy(bad, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    bad[7] = 0x7f;
    CHECK(parse_battery(bad, sizeof(DOCUMENTED_EXAMPLE), &snapshot) == BATTERY);
    CHECK(!snapshot.components[RIGHT].present);

    uint8_t largest[7 + 255 * 5];
    memcpy(largest, BATTERY_HEADER, sizeof(BATTERY_HEADER));
    largest[6] = 255;
    for (unsigned i = 0; i < 255; ++i) {
        const size_t offset = 7 + i * 5;
        largest[offset] = (uint8_t)i;
        largest[offset + 1] = 1;
        largest[offset + 2] = 50;
        largest[offset + 3] = DISCHARGING;
        largest[offset + 4] = 1;
    }
    CHECK(parse_battery(largest, sizeof(largest), &snapshot) == BATTERY);
    CHECK(snapshot.components[LEFT].level == 50 && snapshot.components[RIGHT].level == 50);
    CHECK(parse_battery(largest, sizeof(largest) - 1, &snapshot) == MALFORMED);
    largest[7 + 254 * 5] = 0; /* Duplicate unknown kind must not overwrite data. */
    CHECK(parse_battery(largest, sizeof(largest), &snapshot) == MALFORMED);
}

static void test_json(void)
{
    struct battery_snapshot snapshot;
    uint8_t packet[sizeof(DOCUMENTED_EXAMPLE)];
    memcpy(packet, DOCUMENTED_EXAMPLE, sizeof(packet));
    packet[19] = 0; packet[20] = DISCONNECTED;
    CHECK(parse_battery(packet, sizeof(packet), &snapshot) == BATTERY);
    char line[JSON_CAPACITY];
    const int n = format_snapshot(line, sizeof(line), TEST_MAC, &snapshot, 1700000000);
    CHECK(n > 0 && (size_t)n < sizeof(line));
    CHECK(strstr(line, "\"version\":1,\"type\":\"battery\"") != NULL);
    CHECK(strstr(line, "\"present\":[\"left\",\"right\",\"case\"]") != NULL);
    CHECK(strstr(line, "\"left\":99,\"right\":100,\"case\":null") != NULL);
    CHECK(strstr(line, "\"case\":\"disconnected\"") != NULL);
    CHECK(strstr(line, "\"updated_at\":1700000000") != NULL);
    CHECK(line[n - 1] == '\n');
    CHECK(format_snapshot(line, 10, TEST_MAC, &snapshot, 0) == -1 && errno == EOVERFLOW);

    uint8_t partial[] = {4, 0, 4, 0, 4, 0, 1, 2, 1, 0, 2, 1};
    CHECK(parse_battery(partial, sizeof(partial), &snapshot) == BATTERY);
    CHECK(format_snapshot(line, sizeof(line), TEST_MAC, &snapshot, 1) > 0);
    CHECK(strstr(line, "\"present\":[\"right\"]") != NULL);
    CHECK(strstr(line, "\"left\":null,\"right\":0,\"case\":null") != NULL);
    CHECK(strstr(line, "\"status\":{\"left\":null,\"right\":\"discharging\",\"case\":null}") != NULL);
}

static uint32_t random_word(uint32_t *state)
{
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    return *state;
}

static void test_parser_fuzz(void)
{
    /* Deterministic fuzz-like mutations, reproducible under ASan/UBSan. */
    uint32_t seed = UINT32_C(0x19750923);
    uint8_t packet[1400];
    struct battery_snapshot snapshot;
    for (unsigned trial = 0; trial < 100000; ++trial) {
        size_t length = random_word(&seed) % sizeof(packet);
        for (size_t i = 0; i < length; ++i) packet[i] = (uint8_t)random_word(&seed);
        if (trial % 3 == 0 && length >= 7) {
            memcpy(packet, BATTERY_HEADER, sizeof(BATTERY_HEADER));
            packet[6] = (uint8_t)((length - 7) / 5);
        } else if (trial % 3 == 1) {
            length = sizeof(DOCUMENTED_EXAMPLE);
            memcpy(packet, DOCUMENTED_EXAMPLE, length);
            const size_t offset = random_word(&seed) % length;
            packet[offset] = (uint8_t)random_word(&seed);
        }
        if (parse_battery(packet, length, &snapshot) == BATTERY) {
            for (size_t i = 0; i < COMPONENT_COUNT; ++i) {
                const struct battery_component *component = &snapshot.components[i];
                CHECK(component->level >= -1 && component->level <= 100);
                if (!component->present || component->status == DISCONNECTED || component->status == UNKNOWN)
                    CHECK(component->level == -1);
            }
            char line[JSON_CAPACITY];
            CHECK(format_snapshot(line, sizeof(line), TEST_MAC, &snapshot, 1) > 0);
        }
    }
}

static void make_pair(int pair[2])
{
    CHECK(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, 0, pair) == 0);
}

static void test_transport(void)
{
    int pair[2];
    make_pair(pair);
    uint8_t buffer[64];
    size_t length = 0;
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(10)) == -1);
    CHECK(errno == ETIMEDOUT);
    CHECK(send_packet(pair[1], DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE), deadline_after(100)) == 0);
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(100)) == 0);
    CHECK(length == sizeof(DOCUMENTED_EXAMPLE) && !memcmp(buffer, DOCUMENTED_EXAMPLE, length));
    uint8_t large[100] = {0};
    memcpy(large, DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE));
    CHECK(send_packet(pair[1], large, sizeof(large), deadline_after(100)) == 0);
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(100)) == -1);
    CHECK(errno == EMSGSIZE);
    CHECK(send_packet(pair[1], DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE), deadline_after(100)) == 0);
    CHECK(close(pair[1]) == 0);
    /* A final packet is not discarded when POLLHUP accompanies POLLIN. */
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(100)) == 0);
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(100)) == -1);
    CHECK(errno == ECONNRESET);
    CHECK(send_packet(pair[0], HANDSHAKE, sizeof(HANDSHAKE), deadline_after(100)) == -1);
    CHECK(errno == EPIPE || errno == ECONNRESET);
    CHECK(close(pair[0]) == 0);

    make_pair(pair);
    stopping = 1;
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(100)) == -1);
    CHECK(errno == ECANCELED);
    stopping = 0;
    CHECK(close(pair[0]) == 0);
    CHECK(close(pair[1]) == 0);
    CHECK(wait_fd(-1, POLLIN, deadline_after(5)) == 0); /* poll ignores negative fds. */

    int pipefd[2];
    CHECK(pipe(pipefd) == 0);
    CHECK(make_nonblocking(pipefd[1]) == 0);
    CHECK(close(pipefd[0]) == 0);
    CHECK(write_output(pipefd[1], "{}\n", 3, deadline_after(100)) == -1 && errno == EPIPE);
    CHECK(close(pipefd[1]) == 0);

    CHECK(pipe(pipefd) == 0);
    CHECK(make_nonblocking(pipefd[1]) == 0);
    char block[4096] = {0};
    while (write(pipefd[1], block, sizeof(block)) > 0) {}
    CHECK(errno == EAGAIN || errno == EWOULDBLOCK);
    CHECK(write_output(pipefd[1], "{}\n", 3, deadline_after(10)) == -1 && errno == ETIMEDOUT);
    CHECK(close(pipefd[0]) == 0);
    CHECK(close(pipefd[1]) == 0);

    CHECK(pipe(pipefd) == 0);
    int inherited = dup(pipefd[1]);
    CHECK(inherited >= 0);
    int saved_flags = fcntl(pipefd[1], F_GETFL);
    CHECK(saved_flags >= 0 && !(saved_flags & O_NONBLOCK));
    CHECK(make_nonblocking(pipefd[1]) == 0);
    CHECK(fcntl(inherited, F_GETFL) & O_NONBLOCK);
    CHECK(restore_nonblocking(pipefd[1], saved_flags) == 0);
    CHECK(!(fcntl(inherited, F_GETFL) & O_NONBLOCK));
    CHECK(close(inherited) == 0);
    CHECK(close(pipefd[0]) == 0);
    CHECK(close(pipefd[1]) == 0);
}

static void expect_packet(int fd, const uint8_t *expected, size_t expected_length)
{
    uint8_t buffer[128];
    size_t length;
    CHECK(receive_packet(fd, buffer, sizeof(buffer), &length, deadline_after(2000)) == 0);
    CHECK(length == expected_length && !memcmp(buffer, expected, length));
}

static void wait_child(pid_t child)
{
    int status;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}

static void test_session(bool watch)
{
    int pair[2], output[2];
    make_pair(pair);
    CHECK(pipe(output) == 0);
    CHECK(make_nonblocking(output[1]) == 0);
    const struct session_limits limits = {1000, 1000, 50, 1000};
    pid_t child = fork();
    CHECK(child >= 0);
    if (!child) {
        close(pair[0]); close(output[0]); close(output[1]);
        expect_packet(pair[1], HANDSHAKE, sizeof(HANDSHAKE));
        uint8_t buffer[64]; size_t length;
        /* Nothing may be sent before the handshake reply. */
        CHECK(receive_packet(pair[1], buffer, sizeof(buffer), &length, deadline_after(10)) == -1);
        CHECK(errno == ETIMEDOUT);
        CHECK(send_packet(pair[1], HANDSHAKE_REPLY, sizeof(HANDSHAKE_REPLY), deadline_after(1000)) == 0);
        expect_packet(pair[1], SUBSCRIBE, sizeof(SUBSCRIBE));
        /* No feature-toggle or ANC command after the subscription. */
        CHECK(receive_packet(pair[1], buffer, sizeof(buffer), &length, deadline_after(10)) == -1);
        CHECK(errno == ETIMEDOUT);
        uint8_t malformed[sizeof(DOCUMENTED_EXAMPLE)];
        memcpy(malformed, DOCUMENTED_EXAMPLE, sizeof(malformed));
        malformed[6] = 255;
        CHECK(send_packet(pair[1], malformed, sizeof(malformed), deadline_after(1000)) == 0);
        CHECK(send_packet(pair[1], DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE), deadline_after(1000)) == 0);
        if (watch) {
            expect_packet(pair[1], SUBSCRIBE, sizeof(SUBSCRIBE));
            uint8_t partial[] = {4, 0, 4, 0, 4, 0, 1, 4, 1, 98, 2, 1};
            CHECK(send_packet(pair[1], partial, sizeof(partial), deadline_after(1000)) == 0);
        }
        close(pair[1]);
        _exit(0);
    }
    close(pair[1]);
    int result = run_session(pair[0], output[1], TEST_MAC, watch, &limits);
    CHECK(watch ? result == -1 && errno == ECONNRESET : result == 0);
    close(pair[0]); close(output[1]);
    char text[4096] = {0};
    ssize_t length = read(output[0], text, sizeof(text) - 1);
    CHECK(length > 0);
    CHECK(strstr(text, "\"left\":99,\"right\":100,\"case\":17") != NULL);
    unsigned lines = 0;
    for (ssize_t i = 0; i < length; ++i) if (text[i] == '\n') ++lines;
    CHECK(lines == (watch ? 2u : 1u));
    if (watch) {
        CHECK(strstr(text, "\"present\":[\"left\"]") != NULL);
        CHECK(strstr(text, "\"left\":98,\"right\":null,\"case\":null") != NULL);
    }
    close(output[0]);
    wait_child(child);
}

static void test_unanswered_session(void)
{
    int pair[2], output[2];
    make_pair(pair);
    CHECK(pipe(output) == 0);
    const struct session_limits limits = {10, 10, 5, 20};
    CHECK(run_session(pair[0], output[1], TEST_MAC, false, &limits) == -1);
    CHECK(errno == ETIMEDOUT); /* No handshake response, not EOF. */
    close(pair[0]); close(pair[1]); close(output[1]);
    char byte;
    CHECK(read(output[0], &byte, 1) == 0); /* No fake success JSON. */
    close(output[0]);
}

static void test_silent_watch(void)
{
    int pair[2], output[2];
    make_pair(pair);
    CHECK(pipe(output) == 0);
    CHECK(make_nonblocking(output[1]) == 0);
    const struct session_limits limits = {1000, 1000, 10, 80};
    pid_t child = fork();
    CHECK(child >= 0);
    if (!child) {
        close(pair[0]); close(output[0]); close(output[1]);
        expect_packet(pair[1], HANDSHAKE, sizeof(HANDSHAKE));
        CHECK(send_packet(pair[1], HANDSHAKE_REPLY, sizeof(HANDSHAKE_REPLY), deadline_after(1000)) == 0);
        expect_packet(pair[1], SUBSCRIBE, sizeof(SUBSCRIBE));
        CHECK(send_packet(pair[1], DOCUMENTED_EXAMPLE, sizeof(DOCUMENTED_EXAMPLE), deadline_after(1000)) == 0);
        uint8_t buffer[128]; size_t length;
        const uint8_t unrelated[] = {4, 0, 4, 0, 6, 0, 1, 1};
        for (;;) {
            if (receive_packet(pair[1], buffer, sizeof(buffer), &length, deadline_after(1000)) < 0) {
                CHECK(errno == ECONNRESET);
                break;
            }
            CHECK(length == sizeof(SUBSCRIBE) && !memcmp(buffer, SUBSCRIBE, length));
            int sent = send_packet(pair[1], unrelated, sizeof(unrelated), deadline_after(1000));
            if (sent < 0) {
                CHECK(errno == EPIPE || errno == ECONNRESET);
                break;
            }
        }
        close(pair[1]);
        _exit(0);
    }
    close(pair[1]);
    CHECK(run_session(pair[0], output[1], TEST_MAC, true, &limits) == -1);
    CHECK(errno == ETIMEDOUT); /* Ear-detection traffic is NOT fresh battery data. */
    close(pair[0]); close(output[1]);
    char text[4096];
    ssize_t length = read(output[0], text, sizeof(text));
    CHECK(length > 0);
    unsigned lines = 0;
    for (ssize_t i = 0; i < length; ++i) if (text[i] == '\n') ++lines;
    CHECK(lines == 1);
    close(output[0]);
    wait_child(child);
}

static void test_signal_cancellation(void)
{
    int pair[2];
    make_pair(pair);
    pid_t parent = getpid();
    pid_t child = fork();
    CHECK(child >= 0);
    if (!child) {
        close(pair[0]); close(pair[1]);
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
        CHECK(nanosleep(&delay, NULL) == 0);
        CHECK(kill(parent, SIGTERM) == 0);
        _exit(0);
    }
    uint8_t buffer[64]; size_t length;
    CHECK(receive_packet(pair[0], buffer, sizeof(buffer), &length, deadline_after(1000)) == -1);
    CHECK(errno == ECANCELED);
    CHECK(stopping == 1);
    stopping = 0;
    close(pair[0]); close(pair[1]);
    wait_child(child);
}

int main(void)
{
    CHECK(install_signals() == 0);
    test_mac();
    test_parser();
    test_json();
    test_parser_fuzz();
    test_transport();
    test_session(false);
    test_session(true);
    test_unanswered_session();
    test_silent_watch();
    test_signal_cancellation();
    printf("native AAP: %u assertions passed; 100000 deterministic parser mutations; "
           "seqpacket/timeout/backpressure/one-shot/watch tests passed\n", assertions);
    return 0;
}

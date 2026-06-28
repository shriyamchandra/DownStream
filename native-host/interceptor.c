#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <pwd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <signal.h>
#include <errno.h>

#define DEFAULT_PORT 3000
#define INITIAL_BUF_SIZE 8192

// Get home directory path safely
const char* get_home_dir() {
    const char *home = getenv("HOME");
    if (!home) {
        struct passwd *pw = getpwuid(getuid());
        if (pw) home = pw->pw_dir;
    }
    return home;
}

// Read Express webPort from server-info.json
int read_web_port() {
    const char *home = get_home_dir();
    if (!home) return DEFAULT_PORT;

    char filepath[1024];
    snprintf(filepath, sizeof(filepath), "%s/Library/Application Support/DownStream/server-info.json", home);

    FILE *f = fopen(filepath, "r");
    if (!f) {
        // Fallback for dev mode
        f = fopen("server-info.json", "r");
        if (!f) return DEFAULT_PORT;
    }

    char buf[1024];
    size_t bytes = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[bytes] = '\0';

    // Parse port key: "webPort": <port>
    char *p = strstr(buf, "\"webPort\"");
    if (p) {
        p = strchr(p, ':');
        if (p) {
            p++;
            while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
            int port = atoi(p);
            if (port > 0) return port;
        }
    }
    return DEFAULT_PORT;
}

// Write a Chrome Native Messaging response (4-byte length prefix + JSON body)
void write_nm_response(const char *json) {
    unsigned int len = strlen(json);
    fwrite(&len, 4, 1, stdout);
    fwrite(json, 1, len, stdout);
    fflush(stdout);
}

// Write a structured error response back to Chrome
void write_error(const char *reason) {
    char msg[1024];
    snprintf(msg, sizeof(msg), "{\"success\":false,\"error\":\"%s\"}", reason);
    write_nm_response(msg);
}

// Find the last top-level JSON object in a buffer by matching braces.
// curl with -s outputs only the response body, so this is the JSON we want.
// Returns pointer to start of the JSON object, or NULL if not found.
char* find_json_object(char *buf, int len) {
    // Walk backwards to find the last '}', then find its matching '{'
    int depth = 0;
    int end = -1;
    for (int i = len - 1; i >= 0; i--) {
        if (buf[i] == '}') {
            if (depth == 0) end = i;
            depth++;
        } else if (buf[i] == '{') {
            depth--;
            if (depth == 0) {
                return &buf[i];
            }
        }
    }
    return NULL;
    (void)end; // suppress warning
}

int main() {
    // Read 4-byte length prefix from standard input (Chrome Native Messaging protocol)
    unsigned int len = 0;
    if (fread(&len, 4, 1, stdin) != 1) {
        return 1;
    }
    if (len > 1024 * 1024) { // sanity limit: 1MB
        write_error("Payload too large");
        return 1;
    }

    // Allocate memory for the payload
    char *payload = malloc(len + 1);
    if (!payload) {
        write_error("Memory allocation failed");
        return 1;
    }
    if (fread(payload, 1, len, stdin) != len) {
        free(payload);
        write_error("Incomplete payload read");
        return 1;
    }
    payload[len] = '\0';

    int port = read_web_port();
    char url[256];
    snprintf(url, sizeof(url), "http://127.0.0.1:%d/api/intercept", port);

    // Setup pipes to communicate with curl
    int stdin_pipe[2];
    int stdout_pipe[2];
    if (pipe(stdin_pipe) == -1 || pipe(stdout_pipe) == -1) {
        free(payload);
        write_error("Failed to create pipes");
        return 1;
    }

    pid_t pid = fork();
    if (pid == -1) {
        free(payload);
        write_error("Fork failed");
        return 1;
    }

    if (pid == 0) {
        // Child: execute curl
        close(stdin_pipe[1]);
        close(stdout_pipe[0]);
        dup2(stdin_pipe[0], STDIN_FILENO);
        dup2(stdout_pipe[1], STDOUT_FILENO);
        close(stdin_pipe[0]);
        close(stdout_pipe[1]);

        // Redirect stderr to /dev/null
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull != -1) {
            dup2(devnull, STDERR_FILENO);
            close(devnull);
        }

        char *args[] = {
            "/usr/bin/curl",
            "-s",
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-d", "@-",
            "--max-time", "5",
            "--connect-timeout", "2",
            url,
            NULL
        };
        execv(args[0], args);
        _exit(127); // execv failed
    }

    // Parent
    close(stdin_pipe[0]);
    close(stdout_pipe[1]);

    // Write the input payload to curl's stdin
    write(stdin_pipe[1], payload, len);
    close(stdin_pipe[1]);
    free(payload);

    // Read the HTTP response from curl's stdout into a dynamic buffer.
    // Set a read alarm so we don't hang forever if curl misbehaves.
    int buf_size = INITIAL_BUF_SIZE;
    char *response_buf = malloc(buf_size);
    if (!response_buf) {
        close(stdout_pipe[0]);
        write_error("Memory allocation failed for response");
        return 1;
    }
    int total_bytes = 0;

    // Set non-blocking with a manual timeout via alarm
    alarm(8); // hard timeout: 8 seconds total
    signal(SIGALRM, SIG_DFL); // default handler kills us

    int bytes_read;
    while ((bytes_read = read(stdout_pipe[0], response_buf + total_bytes, buf_size - total_bytes - 1)) > 0) {
        total_bytes += bytes_read;
        // Grow buffer if needed
        if (total_bytes >= buf_size - 1) {
            buf_size *= 2;
            if (buf_size > 1024 * 1024) break; // cap at 1MB
            char *new_buf = realloc(response_buf, buf_size);
            if (!new_buf) break;
            response_buf = new_buf;
        }
    }
    alarm(0); // cancel alarm
    close(stdout_pipe[0]);
    response_buf[total_bytes] = '\0';

    int status;
    waitpid(pid, &status, 0);

    int curl_exit = WIFEXITED(status) ? WEXITSTATUS(status) : -1;

    if (curl_exit == 0 && total_bytes > 0) {
        // Find the JSON object in the response
        char *json = find_json_object(response_buf, total_bytes);
        if (json) {
            write_nm_response(json);
            free(response_buf);
            return 0;
        }
    }

    // Build a descriptive error
    if (curl_exit == 7) {
        write_error("DownStream app is not running (connection refused)");
    } else if (curl_exit == 28) {
        write_error("DownStream app timed out (not responding)");
    } else if (curl_exit == 127) {
        write_error("curl not found at /usr/bin/curl");
    } else if (total_bytes == 0) {
        char msg[256];
        snprintf(msg, sizeof(msg), "No response from server (curl exit %d)", curl_exit);
        write_error(msg);
    } else {
        // Truncate any raw response for the error message
        char snippet[200];
        int snip_len = total_bytes < 150 ? total_bytes : 150;
        memcpy(snippet, response_buf, snip_len);
        snippet[snip_len] = '\0';
        // Escape quotes in snippet for valid JSON
        for (int i = 0; i < snip_len; i++) {
            if (snippet[i] == '"') snippet[i] = '\'';
            if (snippet[i] == '\\') snippet[i] = '/';
            if (snippet[i] < 32) snippet[i] = ' ';
        }
        char msg[512];
        snprintf(msg, sizeof(msg), "Unexpected response (curl exit %d): %s", curl_exit, snippet);
        write_error(msg);
    }

    free(response_buf);
    return 0;
}

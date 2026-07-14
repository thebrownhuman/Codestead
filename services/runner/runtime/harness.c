#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef EXPECTED_LANGUAGE
#error "EXPECTED_LANGUAGE must be defined"
#endif

#define MAX_SOURCES 32
#define HARNESS_FAILURE 125

typedef struct {
  char *items[MAX_SOURCES];
  size_t count;
} source_list;

static void fail(const char *message) {
  fprintf(stderr, "runner harness: %s\n", message);
  exit(HARNESS_FAILURE);
}

static bool has_suffix(const char *value, const char *suffix) {
  size_t value_len = strlen(value);
  size_t suffix_len = strlen(suffix);
  return value_len >= suffix_len &&
         strcmp(value + value_len - suffix_len, suffix) == 0;
}

static bool supported_source(const char *path) {
  if (strcmp(EXPECTED_LANGUAGE, "c") == 0) return has_suffix(path, ".c");
  if (strcmp(EXPECTED_LANGUAGE, "cpp") == 0) {
    return has_suffix(path, ".cpp") || has_suffix(path, ".cc") ||
           has_suffix(path, ".cxx");
  }
  if (strcmp(EXPECTED_LANGUAGE, "java") == 0) return has_suffix(path, ".java");
  return false;
}

static bool safe_relative_path(const char *relative) {
  if (!relative || relative[0] == '\0' || relative[0] == '/' ||
      strlen(relative) >= PATH_MAX) return false;
  const char *segment = relative;
  for (const char *cursor = relative;; cursor++) {
    char value = *cursor;
    if (value == '\0' || value == '/') {
      size_t length = (size_t)(cursor - segment);
      if (length == 0 || (length == 1 && segment[0] == '.') ||
          (length == 2 && segment[0] == '.' && segment[1] == '.')) return false;
      if (value == '\0') break;
      segment = cursor + 1;
      continue;
    }
    bool accepted = (value >= 'A' && value <= 'Z') ||
                    (value >= 'a' && value <= 'z') ||
                    (value >= '0' && value <= '9') || value == '.' ||
                    value == '_' || value == '-';
    if (!accepted) return false;
  }
  return true;
}

static void add_source(source_list *sources, const char *path) {
  if (sources->count >= MAX_SOURCES) fail("too many source files");
  char *copy = strdup(path);
  if (!copy) fail("source list allocation failed");
  sources->items[sources->count++] = copy;
}

static void collect_sources(const char *directory, source_list *sources, int depth) {
  if (depth > 8) fail("source directory nesting is too deep");
  DIR *handle = opendir(directory);
  if (!handle) fail("cannot read source directory");
  struct dirent *entry;
  while ((entry = readdir(handle)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char path[PATH_MAX];
    int written = snprintf(path, sizeof(path), "%s/%s", directory, entry->d_name);
    if (written <= 0 || (size_t)written >= sizeof(path)) {
      closedir(handle);
      fail("source path is too long");
    }
    struct stat info;
    if (lstat(path, &info) != 0) {
      closedir(handle);
      fail("cannot inspect source path");
    }
    if (S_ISLNK(info.st_mode)) {
      closedir(handle);
      fail("symbolic links are not accepted");
    }
    if (S_ISDIR(info.st_mode)) collect_sources(path, sources, depth + 1);
    else if (S_ISREG(info.st_mode) && supported_source(path)) add_source(sources, path);
    else if (!S_ISREG(info.st_mode)) {
      closedir(handle);
      fail("unsupported source object type");
    }
  }
  closedir(handle);
}

static int compare_paths(const void *left, const void *right) {
  const char *const *a = left;
  const char *const *b = right;
  return strcmp(*a, *b);
}

static void controlled_environment(void) {
  if (clearenv() != 0) _exit(HARNESS_FAILURE);
  if (setenv("PATH", "/usr/local/bin:/opt/java/openjdk/bin:/usr/bin:/bin", 1) != 0 ||
      setenv("HOME", "/tmp", 1) != 0 || setenv("LANG", "C.UTF-8", 1) != 0 ||
      setenv("LC_ALL", "C.UTF-8", 1) != 0 || setenv("PYTHONDONTWRITEBYTECODE", "1", 1) != 0) {
    _exit(HARNESS_FAILURE);
  }
}

static int run_command(char *const arguments[]) {
  pid_t child = fork();
  if (child < 0) return HARNESS_FAILURE;
  if (child == 0) {
    controlled_environment();
    execv(arguments[0], arguments);
    _exit(HARNESS_FAILURE);
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return HARNESS_FAILURE;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return HARNESS_FAILURE;
}

static int compile_native(const source_list *sources, bool cpp) {
  char *arguments[48];
  size_t index = 0;
  arguments[index++] = cpp ? "/usr/local/bin/g++" : "/usr/local/bin/gcc";
  arguments[index++] = cpp ? "-std=c++20" : "-std=c23";
  arguments[index++] = "-O0";
  arguments[index++] = "-pipe";
  arguments[index++] = "-Wall";
  arguments[index++] = "-Wextra";
  arguments[index++] = "-Wpedantic";
  arguments[index++] = "-fdiagnostics-color=never";
  arguments[index++] = "-I/input";
  arguments[index++] = "-o";
  arguments[index++] = "/work/program";
  for (size_t source = 0; source < sources->count; source++) {
    arguments[index++] = sources->items[source];
  }
  arguments[index] = NULL;
  return run_command(arguments);
}

static int compile_java(const source_list *sources) {
  char *arguments[48];
  size_t index = 0;
  arguments[index++] = "/opt/java/openjdk/bin/javac";
  arguments[index++] = "-J-Xms8m";
  arguments[index++] = "-J-Xmx64m";
  arguments[index++] = "-J-XX:MaxMetaspaceSize=48m";
  arguments[index++] = "-J-XX:ReservedCodeCacheSize=16m";
  arguments[index++] = "-J-XX:+UseSerialGC";
  arguments[index++] = "-J-XX:ActiveProcessorCount=1";
  arguments[index++] = "-encoding";
  arguments[index++] = "UTF-8";
  arguments[index++] = "-proc:none";
  arguments[index++] = "-d";
  arguments[index++] = "/work/classes";
  for (size_t source = 0; source < sources->count; source++) {
    arguments[index++] = sources->items[source];
  }
  arguments[index] = NULL;
  return run_command(arguments);
}

static int compile_script(const char *entrypoint, bool python) {
  if (python) {
    char *arguments[] = {
      "/usr/local/bin/python3", "-I", "-B", "-c",
      "import py_compile,sys; py_compile.compile(sys.argv[1], cfile='/work/program.pyc', doraise=True)",
      (char *)entrypoint, NULL,
    };
    return run_command(arguments);
  }
  char *arguments[] = {
    "/usr/local/bin/node", "--check", (char *)entrypoint, NULL,
  };
  return run_command(arguments);
}

static char *java_main_class(const char *entrypoint) {
  const char *relative = entrypoint + strlen("/input/");
  size_t length = strlen(relative);
  if (length <= 5 || !has_suffix(relative, ".java")) fail("Java entrypoint must end in .java");
  char *name = strndup(relative, length - 5);
  if (!name) fail("Java main class allocation failed");
  for (char *cursor = name; *cursor; cursor++) if (*cursor == '/') *cursor = '.';
  return name;
}

static int run_program(const char *entrypoint) {
  if (strcmp(EXPECTED_LANGUAGE, "c") == 0 || strcmp(EXPECTED_LANGUAGE, "cpp") == 0) {
    char *arguments[] = { "/work/program", NULL };
    return run_command(arguments);
  }
  if (strcmp(EXPECTED_LANGUAGE, "java") == 0) {
    char *main_class = java_main_class(entrypoint);
    char *arguments[] = {
      "/opt/java/openjdk/bin/java", "-Xms8m", "-Xmx64m",
      "-XX:MaxMetaspaceSize=48m", "-XX:ReservedCodeCacheSize=16m",
      "-XX:+UseSerialGC", "-XX:ActiveProcessorCount=1", "-Djava.io.tmpdir=/tmp",
      "-cp", "/work/classes", main_class, NULL,
    };
    int status = run_command(arguments);
    free(main_class);
    return status;
  }
  if (strcmp(EXPECTED_LANGUAGE, "python") == 0) {
    char *arguments[] = { "/usr/local/bin/python3", "-I", "-B", (char *)entrypoint, NULL };
    return run_command(arguments);
  }
  char *arguments[] = {
    "/usr/local/bin/node", "--disable-proto=throw", "--no-addons", (char *)entrypoint, NULL,
  };
  return run_command(arguments);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--describe") == 0) {
    printf("{\"protocolVersion\":1,\"language\":\"%s\",\"compileThenRun\":true,\"shell\":false}\n", EXPECTED_LANGUAGE);
    return 0;
  }
  const char *mode = NULL;
  const char *language = NULL;
  const char *source_root = NULL;
  const char *entrypoint = NULL;
  if (argc != 9) fail("expected exactly four named arguments");
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc) fail("argument value is missing");
    if (strcmp(argv[index], "--mode") == 0 && !mode) mode = argv[index + 1];
    else if (strcmp(argv[index], "--language") == 0 && !language) language = argv[index + 1];
    else if (strcmp(argv[index], "--source-root") == 0 && !source_root) source_root = argv[index + 1];
    else if (strcmp(argv[index], "--entrypoint") == 0 && !entrypoint) entrypoint = argv[index + 1];
    else fail("unknown or duplicate argument");
  }
  if (!mode || (strcmp(mode, "compile") != 0 && strcmp(mode, "run") != 0)) fail("mode is invalid");
  if (!language || strcmp(language, EXPECTED_LANGUAGE) != 0) fail("language does not match image");
  if (!source_root || strcmp(source_root, "/input") != 0) fail("source root must be /input");
  if (!entrypoint || strncmp(entrypoint, "/input/", 7) != 0 || !safe_relative_path(entrypoint + 7)) {
    fail("entrypoint is not a safe /input path");
  }
  struct stat entry_info;
  if (lstat(entrypoint, &entry_info) != 0 || !S_ISREG(entry_info.st_mode) || S_ISLNK(entry_info.st_mode)) {
    fail("entrypoint is not a regular source file");
  }
  if (chdir("/work") != 0) fail("/work is unavailable");

  source_list sources = { .count = 0 };
  int compile_status;
  if (strcmp(EXPECTED_LANGUAGE, "c") == 0 || strcmp(EXPECTED_LANGUAGE, "cpp") == 0 ||
      strcmp(EXPECTED_LANGUAGE, "java") == 0) {
    collect_sources("/input", &sources, 0);
    if (sources.count == 0) fail("no compilable source files found");
    qsort(sources.items, sources.count, sizeof(char *), compare_paths);
    compile_status = strcmp(EXPECTED_LANGUAGE, "java") == 0
      ? compile_java(&sources)
      : compile_native(&sources, strcmp(EXPECTED_LANGUAGE, "cpp") == 0);
  } else {
    compile_status = compile_script(entrypoint, strcmp(EXPECTED_LANGUAGE, "python") == 0);
  }
  for (size_t index = 0; index < sources.count; index++) free(sources.items[index]);
  if (compile_status != 0 || strcmp(mode, "compile") == 0) return compile_status;
  return run_program(entrypoint);
}

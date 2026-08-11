#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <sys/param.h>
#include <unistd.h>

static int write_all(const char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(STDOUT_FILENO, buffer + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      return 1;
    }
    if (written == 0) {
      return 1;
    }
    offset += (size_t)written;
  }
  return 0;
}

int main(void) {
  char path[MAXPATHLEN];
  memset(path, 0, sizeof(path));
  if (fcntl(3, F_GETPATH, path) == -1) {
    return 2;
  }

  const char *terminator = memchr(path, '\0', sizeof(path));
  if (terminator == NULL || terminator == path || path[0] != '/') {
    return 3;
  }
  return write_all(path, (size_t)(terminator - path));
}

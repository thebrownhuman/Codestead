#!/bin/bash
set -euo pipefail
JAVA=/usr/local/jdk/bin/java
# Pin every ergonomic choice so the archive does not depend on the build host's
# RAM or CPU count (G1 vs Serial, heap size and compressed-oops mode change the
# archived heap). These mirror javaLimits in install-packages.mjs so runtime
# maps the archive.
JFLAGS=(-Xms8m -Xmx64m -XX:MaxMetaspaceSize=48m -XX:ReservedCodeCacheSize=16m
    -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -XX:+UseCompressedOops
    -XX:+UseCompressedClassPointers -XX:SharedBaseAddress=0x800000000)
mkdir -p /tmp/cds-warm/classes
cat > /tmp/cds-warm/Warm.java <<'EOF'
public class Warm { public static void main(String[] args) { System.out.println("hello"); } }
EOF
# Record the real compiler system-module classes without an application classpath.
"$JAVA" "${JFLAGS[@]}" -XX:DumpLoadedClassList=/tmp/cds-warm/raw.classlist \
    -m jdk.compiler/com.sun.tools.javac.Main -d /tmp/cds-warm/classes /tmp/cds-warm/Warm.java
# The raw list's order and ids vary between runs, and a dynamic archive
# (archive-at-exit) is never byte-identical. A static dump of a sorted,
# id-free class list is, which keeps the image digest reproducible.
sed -n 's/^\([A-Za-z0-9_$/]*\)\( id: [0-9]*\)\{0,1\}$/\1/p' /tmp/cds-warm/raw.classlist \
    | LC_ALL=C sort -u > /tmp/cds-warm/codestead.classlist
test "$(wc -l < /tmp/cds-warm/codestead.classlist)" -gt 1000
"$JAVA" "${JFLAGS[@]}" -Xshare:dump -XX:SharedClassListFile=/tmp/cds-warm/codestead.classlist \
    -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa > /tmp/cds-warm/dump.log 2>&1 \
    || { cat /tmp/cds-warm/dump.log; exit 1; }
test -s /usr/local/jdk/lib/codestead.jsa
"$JAVA" "${JFLAGS[@]}" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -m jdk.compiler/com.sun.tools.javac.Main -version
test "$("$JAVA" "${JFLAGS[@]}" -XX:SharedArchiveFile=/usr/local/jdk/lib/codestead.jsa -Xshare:on \
    -cp /tmp/cds-warm/classes Warm)" = hello
rm -rf /tmp/cds-warm

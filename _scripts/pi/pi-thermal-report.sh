#!/bin/sh
#
# Summarizes the CSV written by pi-thermal-log.sh.
#
#   pi-thermal-report          # last 24 hours
#   pi-thermal-report 168      # last week
#   pi-thermal-report all      # everything on disk
#
# The "now" flags below are sampled per row, so their counts say how much of
# the window the Pi actually spent throttled. The "since boot" flags are sticky
# until the next reboot, so they only answer whether it ever happened at all.

set -eu

LOG=/var/log/pi-thermal/thermal.csv
WINDOW=${1:-24}

if [ ! -s "$LOG" ]; then
    echo "No thermal log yet at $LOG (the timer samples once a minute)." >&2
    exit 1
fi

if [ "$WINDOW" = "all" ]; then
    CUTOFF=0
else
    CUTOFF=$(( $(date +%s) - WINDOW * 3600 ))
fi

awk -F, -v cutoff="$CUTOFF" -v window="$WINDOW" '
function hex2dec(s,   i, c, v, n, digits) {
    sub(/^0[xX]/, "", s); s = tolower(s); digits = "0123456789abcdef"; n = 0
    for (i = 1; i <= length(s); i++) {
        v = index(digits, substr(s, i, 1)) - 1
        if (v >= 0) n = n * 16 + v
    }
    return n
}
function bit(n, b) { return int(n / (2 ^ b)) % 2 }
function pct(a, b) { return b ? sprintf("%d%%", (a * 100) / b) : "0%" }

NR > 1 && $1 >= cutoff {
    n++
    t = $3 + 0
    sum += t
    if (t > max) { max = t; max_at = $2; max_load = $6 }
    if (min == 0 || t < min) min = t
    if (t >= 80) hot++

    hz = $5 + 0
    if (hz > 0) { if (min_hz == 0 || hz < min_hz) min_hz = hz; if (hz > max_hz) max_hz = hz }

    f = hex2dec($4)
    if (bit(f, 0)) uv++
    if (bit(f, 1)) capped++
    if (bit(f, 2)) thr++
    if (bit(f, 3)) soft++
    if (bit(f, 16)) uv_ever = 1
    if (bit(f, 19)) soft_ever = 1

    up = $7 + 0
    if (prev_up > 0 && up < prev_up) reboots++
    prev_up = up

    if (!first) first = $2
    last = $2
}
END {
    if (!n) { print "No samples in that window."; exit 1 }
    label = (window == "all") ? "all recorded" : "last " window "h"
    printf "Pi thermal report -- %s (%d samples, %s -> %s)\n\n", label, n, first, last
    printf "Temperature   min %.1fC   avg %.1fC   max %.1fC\n", min, sum / n, max
    printf "Peak          %.1fC at %s (load %s)\n", max, max_at, max_load
    printf "Above 80C     %d samples (%s of the window)\n\n", hot, pct(hot, n)
    print  "Flags (sampled per row):"
    printf "  under-voltage now        %6d  %s\n", uv, pct(uv, n)
    printf "  arm frequency capped     %6d  %s\n", capped, pct(capped, n)
    printf "  throttled now            %6d  %s\n", thr, pct(thr, n)
    printf "  soft temp limit active   %6d  %s\n", soft, pct(soft, n)
    printf "\nSince-boot sticky flags:  under-voltage %s | soft temp limit %s\n",
        (uv_ever ? "SEEN" : "clean"), (soft_ever ? "SEEN" : "clean")
    printf "Clock         %.2f - %.2f GHz\n", min_hz / 1e9, max_hz / 1e9
    printf "Reboots       %d detected in window\n", reboots
    if (uv_ever) print "\nNote: under-voltage seen -- suspect the PSU or cable, not cooling."
}
' "$LOG"

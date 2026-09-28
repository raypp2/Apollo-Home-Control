#!/bin/sh
#
# Samples the Pi's thermal / throttle state into a CSV for post-mortem analysis.
#
# Written for the 2026-08-02 outage: the Pi stopped dead with nothing in the
# journal, and the firmware's throttle flags reset on boot, so the pre-crash
# thermal state was unrecoverable. This makes that state recoverable next time.
#
# Runs from pi-thermal-log.timer (every 60s). Deliberately a plain append to a
# file rather than an MQTT publish or a journal write: if the SoC hard-locks,
# whatever already reached disk is the evidence, and a retained MQTT message
# only ever holds the latest value.
#
# Columns:
#   epoch      - unix seconds, for cheap range filtering in the report
#   timestamp  - ISO-8601 local time, for humans
#   temp_c     - SoC temperature
#   throttled  - vcgencmd get_throttled bitfield (0x0 = clean; see report)
#   arm_hz     - current ARM clock; well under nominal means it is throttling
#   load1      - 1-minute load average, to separate "hot because busy" from
#                "hot at idle" (the latter is a cooling fault)
#   uptime_s   - resets on boot, so a reboot is visible as a discontinuity

set -eu

LOG_DIR=/var/log/pi-thermal
LOG="$LOG_DIR/thermal.csv"

mkdir -p "$LOG_DIR"

# Re-add the header on a fresh file, including after logrotate's copytruncate.
if [ ! -s "$LOG" ]; then
    echo "epoch,timestamp,temp_c,throttled,arm_hz,load1,uptime_s" > "$LOG"
fi

epoch=$(date +%s)
timestamp=$(date -Is)
# measure_temp prints "temp=82.3'C" -- keep only digits and the decimal point.
temp_c=$(vcgencmd measure_temp | tr -dc '0-9.')
throttled=$(vcgencmd get_throttled | cut -d= -f2)
arm_hz=$(vcgencmd measure_clock arm | cut -d= -f2)
load1=$(cut -d' ' -f1 /proc/loadavg)
uptime_s=$(cut -d' ' -f1 /proc/uptime)

echo "$epoch,$timestamp,$temp_c,$throttled,$arm_hz,$load1,$uptime_s" >> "$LOG"

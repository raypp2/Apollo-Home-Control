#!/bin/sh
#
# Installs the Pi thermal logger (sampler + timer + logrotate + report tool).
# Idempotent -- safe to re-run after editing any of the files alongside it.
#
# Run ON THE PI, from this directory:
#     sudo sh install-thermal-logging.sh
#
# Uninstall:
#     sudo systemctl disable --now pi-thermal-log.timer
#     sudo rm /usr/local/bin/pi-thermal-log.sh /usr/local/bin/pi-thermal-report \
#             /etc/systemd/system/pi-thermal-log.{service,timer} \
#             /etc/logrotate.d/pi-thermal
#     sudo systemctl daemon-reload
#   (the collected CSV in /var/log/pi-thermal/ is left alone deliberately)

set -eu

SRC=$(dirname "$0")

install -m 755 "$SRC/pi-thermal-log.sh"    /usr/local/bin/pi-thermal-log.sh
install -m 755 "$SRC/pi-thermal-report.sh" /usr/local/bin/pi-thermal-report
install -m 644 "$SRC/pi-thermal-log.service" /etc/systemd/system/pi-thermal-log.service
install -m 644 "$SRC/pi-thermal-log.timer"   /etc/systemd/system/pi-thermal-log.timer
install -m 644 "$SRC/logrotate-pi-thermal"   /etc/logrotate.d/pi-thermal

systemctl daemon-reload
systemctl enable --now pi-thermal-log.timer

# Take one sample immediately so the log is never empty right after install.
systemctl start pi-thermal-log.service

echo "Installed. Next run:"
systemctl list-timers pi-thermal-log.timer --no-pager | sed -n '1,2p'
echo
echo "Review with:  pi-thermal-report        (last 24h)"
echo "              pi-thermal-report 168    (last week)"
echo "              pi-thermal-report all"

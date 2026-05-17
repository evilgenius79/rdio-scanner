#!/bin/bash
# scanner-status - quick health check for the rdio-scanner stack on this Pi.
#
# Run interactively (`scanner-status`) or wire it as an MOTD via
# /etc/profile.d/ to see the summary on every SSH login.
#
# Exit code is 0 if rdio-scanner AND uniden-recorder are both active,
# 1 otherwise -- handy for cron heartbeats / monitoring hooks.

set -uo pipefail

# ---- config (edit if your install differs) -----------------------------
RDIO_SERVICE="rdio-scanner"
RECORDER_SERVICE="uniden-recorder"
TRANSCRIBER_SERVICE="transcriber"
CALL_DIR="/home/scanner/scanner-calls"
TRANSCRIPTS_DIR="/home/scanner/scanner-transcripts"
RDIO_PORT="3000"
# ------------------------------------------------------------------------

# ANSI colours, but skip them if stdout isn't a terminal (cron, MOTD).
if [ -t 1 ]; then
    GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'
    DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
else
    GREEN=""; RED=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi

dot_for() {
    case "$1" in
        active)        printf '%s●%s' "$GREEN" "$RESET" ;;
        activating)    printf '%s●%s' "$YELLOW" "$RESET" ;;
        inactive)      printf '%s○%s' "$DIM" "$RESET" ;;
        failed|*)      printf '%s●%s' "$RED" "$RESET" ;;
    esac
}

service_line() {
    local name="$1"
    local label="$2"
    local optional="${3:-false}"
    local state since
    state="$(systemctl is-active "$name" 2>/dev/null || true)"
    if [ "$optional" = "true" ] && [ "$state" = "inactive" ]; then
        # Optional service not installed -- show as muted rather than red.
        printf '  %s○ %-22s %snot installed%s\n' "$DIM" "$label:" "$DIM" "$RESET"
        return
    fi
    since="$(systemctl show -p ActiveEnterTimestamp --value "$name" 2>/dev/null)"
    [ -z "$since" ] && since="—"
    printf '  %s %-22s %s%s%s    %s%s%s\n' \
        "$(dot_for "$state")" "$label:" "$BOLD" "$state" "$RESET" \
        "$DIM" "$since" "$RESET"
}

human_age() {
    # "minutes since file mtime" -> "37s / 5m / 2h / 3d ago".
    local secs="$1"
    if [ -z "$secs" ] || [ "$secs" -lt 0 ]; then
        printf '—'
    elif [ "$secs" -lt 60 ]; then
        printf '%ds ago' "$secs"
    elif [ "$secs" -lt 3600 ]; then
        printf '%dm ago' $((secs / 60))
    elif [ "$secs" -lt 86400 ]; then
        printf '%dh ago' $((secs / 3600))
    else
        printf '%dd ago' $((secs / 86400))
    fi
}

printf '\n%srdio-scanner status%s   %s%s%s\n' \
    "$BOLD" "$RESET" "$DIM" "$(date '+%Y-%m-%d %H:%M:%S')" "$RESET"
printf '%s%s%s\n' "$DIM" "─────────────────────────────────────────────" "$RESET"

service_line "$RDIO_SERVICE"        "Rdio Scanner"
service_line "$RECORDER_SERVICE"    "Uniden recorder"
service_line "$TRANSCRIBER_SERVICE" "Transcriber" "true"

# ---- pending wav backlog -----------------------------------------------
if [ -d "$CALL_DIR" ]; then
    pending=$(find "$CALL_DIR" -maxdepth 1 -type f -name '*.wav' 2>/dev/null | wc -l)
    last_wav=$(find "$CALL_DIR" -maxdepth 1 -type f -name '*.wav' -printf '%T@\n' 2>/dev/null \
                | sort -nr | head -n1 | cut -d. -f1)
    if [ -n "$last_wav" ]; then
        now=$(date +%s)
        age=$((now - last_wav))
        last_str="$(human_age "$age")"
    else
        last_str="(none yet)"
    fi
    printf '  %s● %-22s %s%s%s    %slast: %s%s\n' \
        "$RESET" "Pending WAVs:" "$BOLD" "$pending" "$RESET" "$DIM" "$last_str" "$RESET"
else
    printf '  %s● %-22s %smissing%s\n' "$RED" "Call dir:" "$RED" "$RESET"
fi

# ---- transcripts (only if the dir exists) ------------------------------
if [ -d "$TRANSCRIPTS_DIR" ]; then
    txt_count=$(find "$TRANSCRIPTS_DIR" -maxdepth 1 -type f -name '*.txt' 2>/dev/null | wc -l)
    printf '  %s● %-22s %s%s%s    %sfiles%s\n' \
        "$RESET" "Transcripts:" "$BOLD" "$txt_count" "$RESET" "$DIM" "$RESET"
fi

# ---- HTTP health probe --------------------------------------------------
http_status="?"
if command -v curl >/dev/null 2>&1; then
    http_status=$(curl -s -o /dev/null -w '%{http_code}' \
        --max-time 3 "http://127.0.0.1:${RDIO_PORT}/" 2>/dev/null || echo "?")
fi
http_dot="$(dot_for inactive)"
case "$http_status" in
    200|301|302|304) http_dot="$(dot_for active)" ;;
    "?"|000)         http_dot="$(dot_for failed)" ;;
esac
printf '  %s %-22s %sHTTP %s%s\n' "$http_dot" "Web admin (:${RDIO_PORT}):" "$BOLD" "$http_status" "$RESET"

# ---- disk free ----------------------------------------------------------
read -r _ size used avail pct mp <<<"$(df -h /home 2>/dev/null | tail -n1)"
[ -z "${avail:-}" ] && { avail="—"; pct="—"; }
disk_dot="$(dot_for active)"
pct_num=${pct%\%}
[[ "$pct_num" =~ ^[0-9]+$ ]] && [ "$pct_num" -ge 90 ] && disk_dot="$(dot_for failed)"
[[ "$pct_num" =~ ^[0-9]+$ ]] && [ "$pct_num" -ge 75 ] && [ "$pct_num" -lt 90 ] && disk_dot="$(dot_for activating)"
printf '  %s %-22s %s%s%s free   %s(%s used)%s\n' \
    "$disk_dot" "Disk (/home):" "$BOLD" "$avail" "$RESET" "$DIM" "$pct" "$RESET"

# ---- recent error count from rdio-scanner logs --------------------------
errs_1h=$(journalctl -u "$RDIO_SERVICE" --since '1 hour ago' --no-pager 2>/dev/null \
            | grep -ciE 'error|fatal|panic' || true)
err_dot="$(dot_for active)"
[ "${errs_1h:-0}" -gt 0 ]   && err_dot="$(dot_for activating)"
[ "${errs_1h:-0}" -gt 50 ]  && err_dot="$(dot_for failed)"
printf '  %s %-22s %s%s%s    %s(in last hour)%s\n' \
    "$err_dot" "Server errors:" "$BOLD" "${errs_1h:-0}" "$RESET" "$DIM" "$RESET"

printf '\n'

# Exit code so this can be a heartbeat: 0 = both core services up.
rdio_state="$(systemctl is-active "$RDIO_SERVICE" 2>/dev/null || true)"
recorder_state="$(systemctl is-active "$RECORDER_SERVICE" 2>/dev/null || true)"
[ "$rdio_state" = "active" ] && [ "$recorder_state" = "active" ] && exit 0
exit 1

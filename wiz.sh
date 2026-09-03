#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# wiz.sh - WiZ smart bulb controller (UDP, no daemon, no polling)
# -----------------------------------------------------------------------------
# All bulb logic lives here. The GNOME extension is only a UI wrapper that
# calls this script and renders the JSON it prints.
#
# Every command that changes the bulb is verified: after sending, the bulb
# state is read back and compared with what was requested. If the bulb did not
# confirm, the command is sent once more. On success the verified state is
# printed as JSON on stdout (the "result" object of getPilot), for example:
#   {"mac":"...","rssi":-51,"state":true,"sceneId":0,"temp":4500,"dimming":100}
#
# Usage:
#   wiz.sh [--ip IP] [--port PORT] COMMAND [OPTIONS]
#
# Commands:
#   --on                    Turn the bulb on
#   --off                   Turn the bulb off
#   --toggle                Turn the bulb off if it is on, otherwise on
#   --brightness N          Set brightness 10-100 % (implies on)
#   --temp K                Set white balance 2200-6500 K (implies on)
#   --rgb R G B             Set an RGB colour, 0-255 each (implies on)
#   --hex #RRGGBB           Same as --rgb, from a hex colour
#   --preset NAME           warmest | warm | day | cool | night
#   --pick                  Choose a colour with zenity, then apply it
#   --status                Print the current bulb state (read only)
#
# --brightness may be combined with --temp, --rgb, --hex or --preset.
#
# Exit codes: 0 ok, 1 invalid usage/arguments, 2 colour picker cancelled,
#             3 bulb unreachable or change not confirmed (message on stderr).
# Requires: bash 4+. Uses bash /dev/udp sockets, falls back to nc if needed.
# -----------------------------------------------------------------------------

set -euo pipefail

BULB_IP="${BULB_IP:-192.168.1.11}"
BULB_PORT="${BULB_PORT:-38899}"
TIMEOUT="${WIZ_TIMEOUT:-1}"      # seconds to wait for a UDP reply (whole number for nc)
SEND_ATTEMPTS=2                  # sends for a plain --status when the bulb is silent
VERIFY_ATTEMPTS=2                # apply + read back, retried once

TEMP_MIN=2200
TEMP_MAX=6500
DIM_MIN=10                       # WiZ bulbs do not dim below 10 %
DIM_MAX=100
NIGHT_DIMMING=10

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

usage() {
    cat <<EOF
Usage: $(basename "$0") [--ip IP] [--port PORT] COMMAND [OPTIONS]

Commands:
  --on                    Turn the bulb on
  --off                   Turn the bulb off
  --toggle                Turn the bulb off if it is on, otherwise on
  --brightness N          Set brightness $DIM_MIN-$DIM_MAX % (implies on)
  --temp K                Set white balance $TEMP_MIN-$TEMP_MAX K (implies on)
  --rgb R G B             Set an RGB colour, 0-255 each (implies on)
  --hex #RRGGBB           Same as --rgb, from a hex colour
  --preset NAME           warmest | warm | day | cool | night
  --pick                  Choose a colour with zenity, then apply it
  --status                Print the current bulb state (read only)

--brightness may be combined with --temp, --rgb, --hex or --preset.
Every change is read back from the bulb and retried once if not confirmed.
On success the verified bulb state is printed as JSON.
Exit codes: 0 ok, 1 invalid arguments, 2 picker cancelled, 3 bulb unreachable.

Defaults: --ip $BULB_IP --port $BULB_PORT (env BULB_IP, BULB_PORT, WIZ_TIMEOUT)
EOF
}

error() {
    echo "Error: $*" >&2
    exit 1
}

# Communication failure: the bulb did not answer or did not apply the change.
fail_bulb() {
    echo "Error: $*" >&2
    exit 3
}

is_int() {
    [[ "$1" =~ ^-?[0-9]+$ ]]
}

require_int_range() {
    local name="$1" value="$2" min="$3" max="$4"
    is_int "$value" || error "$name must be an integer ($min-$max)"
    ((value >= min && value <= max)) || error "$name must be $min-$max"
}

validate_ip() {
    local ip="$1" octet
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || error "Invalid IP address: $ip"
    IFS='.' read -ra octets <<<"$ip"
    for octet in "${octets[@]}"; do
        ((10#$octet <= 255)) || error "Invalid IP address: $ip"
    done
}

# Extract a scalar value from a flat JSON object: json_get '<json>' key
json_get() {
    local json="$1" key="$2"
    if [[ "$json" =~ \"$key\":([^,}]+) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

# -----------------------------------------------------------------------------
# UDP transport
# -----------------------------------------------------------------------------

# Send one datagram and print the reply.
# Returns 1 when the bulb stays silent, 2 when bash sockets are unusable.
udp_exchange_bash() {
    local msg="$1" reply="" polls i

    { exec 3<>"/dev/udp/$BULB_IP/$BULB_PORT"; } 2>/dev/null || return 2
    printf '%s' "$msg" >&3 2>/dev/null || { exec 3>&-; return 1; }

    # A datagram is consumed by a single read(), so the reply must be taken in
    # one block read (-N). Poll first with "read -t 0" (which consumes nothing)
    # so we return as soon as the reply arrives instead of waiting the full
    # timeout.
    polls=$(awk -v t="$TIMEOUT" 'BEGIN { printf "%d", (t * 100 < 1) ? 1 : t * 100 }')
    for ((i = 0; i < polls; i++)); do
        read -t 0 <&3 2>/dev/null && break
        sleep 0.01
    done
    IFS= read -r -N 65536 -t 0.05 reply <&3 2>/dev/null || true
    exec 3>&-

    [[ -n "$reply" ]] || return 1
    # Older bash reads sockets byte-wise and would truncate the datagram.
    [[ "$reply" == \{*\} ]] || return 2
    printf '%s' "$reply"
}

udp_exchange_nc() {
    local msg="$1" reply
    command -v nc >/dev/null 2>&1 || error "nc (netcat) is required for the UDP fallback"
    reply=$(printf '%s' "$msg" | nc -u -w"${TIMEOUT%.*}" "$BULB_IP" "$BULB_PORT" 2>/dev/null || true)
    [[ -n "$reply" ]] || return 1
    printf '%s' "$reply"
}

# udp_exchange MESSAGE [ATTEMPTS] - print the reply, retrying silent sends.
udp_exchange() {
    local msg="$1" attempts="${2:-1}" attempt reply rc

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        rc=0
        reply=$(udp_exchange_bash "$msg") || rc=$?
        if ((rc == 2)); then
            rc=0
            reply=$(udp_exchange_nc "$msg") || rc=1
        fi
        if ((rc == 0)) && [[ -n "$reply" ]]; then
            printf '%s' "$reply"
            return 0
        fi
        ((attempt < attempts)) && sleep 0.2
    done
    return 1
}

# get_state [ATTEMPTS] - print the "result" object of getPilot.
get_state() {
    local reply
    reply=$(udp_exchange '{"method":"getPilot","params":{}}' "${1:-$SEND_ATTEMPTS}") \
        || fail_bulb "No response from $BULB_IP:$BULB_PORT"

    if [[ "$reply" =~ \"result\":(\{[^}]*\}) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    else
        fail_bulb "Unexpected reply from bulb: $reply"
    fi
}

# -----------------------------------------------------------------------------
# Apply + verify
# -----------------------------------------------------------------------------

# Requested parameters, key -> value (JSON literal)
declare -A PARAMS=()

params_json() {
    local key body=""
    for key in state dimming temp r g b; do
        [[ -v PARAMS[$key] ]] || continue
        body+="${body:+,}\"$key\":${PARAMS[$key]}"
    done
    printf '{%s}' "$body"
}

# Compare the bulb state with the requested parameters.
state_matches() {
    local state="$1" key actual
    for key in "${!PARAMS[@]}"; do
        actual=$(json_get "$state" "$key") || return 1
        [[ "$actual" == "${PARAMS[$key]}" ]] || return 1
    done
    return 0
}

describe_mismatch() {
    local state="$1" key actual out=""
    for key in state dimming temp r g b; do
        [[ -v PARAMS[$key] ]] || continue
        actual=$(json_get "$state" "$key") || actual="missing"
        [[ "$actual" == "${PARAMS[$key]}" ]] && continue
        out+="${out:+, }$key: wanted ${PARAMS[$key]}, bulb has $actual"
    done
    printf '%s' "$out"
}

# Send setState with PARAMS, then read the state back. Retries once.
apply_and_verify() {
    local attempt reply state="" last_error="" errmsg

    for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++)); do
        if reply=$(udp_exchange "{\"method\":\"setState\",\"params\":$(params_json)}" 1); then
            if errmsg=$(json_get "$reply" "message") 2>/dev/null && [[ "$reply" == *'"error"'* ]]; then
                last_error="bulb rejected the command: ${errmsg//\"/}"
            fi
        else
            last_error="no reply to setState"
        fi

        if state=$(get_state 1 2>/dev/null); then
            if state_matches "$state"; then
                printf '%s\n' "$state"
                return 0
            fi
            last_error="bulb did not confirm ($(describe_mismatch "$state"))"
        else
            last_error="no reply when reading the state back"
        fi

        ((attempt < VERIFY_ATTEMPTS)) && sleep 0.3
    done

    fail_bulb "Change not confirmed by $BULB_IP after $VERIFY_ATTEMPTS attempts: $last_error"
}

# -----------------------------------------------------------------------------
# Colour helpers
# -----------------------------------------------------------------------------

hex_to_rgb() {
    local hex="${1#\#}"
    if [[ "$hex" =~ ^[0-9a-fA-F]{3}$ ]]; then
        hex="${hex:0:1}${hex:0:1}${hex:1:1}${hex:1:1}${hex:2:1}${hex:2:1}"
    fi
    [[ "$hex" =~ ^[0-9a-fA-F]{6}$ ]] || error "Invalid colour '$1' (use #RRGGBB)"
    printf '%d %d %d' "0x${hex:0:2}" "0x${hex:2:2}" "0x${hex:4:2}"
}

# Run the zenity colour dialog. Prints "R G B", exits 2 when cancelled.
pick_colour() {
    command -v zenity >/dev/null 2>&1 \
        || error "zenity is not installed; type a hex colour instead"

    local tmp pid rc=0 out
    tmp=$(mktemp)
    # Run in the background so a SIGTERM from the extension also ends zenity.
    zenity --color-selection --show-palette --title="WiZ colour" >"$tmp" 2>/dev/null &
    pid=$!
    trap 'kill "$pid" 2>/dev/null; rm -f "$tmp"; exit 2' TERM INT
    wait "$pid" || rc=$?
    trap - TERM INT
    out=$(<"$tmp")
    rm -f "$tmp"

    ((rc == 0)) || exit 2

    if [[ "$out" =~ ^rgb\(([0-9]+),[[:space:]]*([0-9]+),[[:space:]]*([0-9]+)\) ]]; then
        printf '%d %d %d' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    elif [[ "$out" =~ ^rgba\(([0-9]+),[[:space:]]*([0-9]+),[[:space:]]*([0-9]+), ]]; then
        printf '%d %d %d' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    elif [[ "$out" =~ ^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$ ]]; then
        hex_to_rgb "${BASH_REMATCH[1]}"
    elif [[ "$out" =~ ^#([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})$ ]]; then
        # 16-bit-per-channel form (#rrrrggggbbbb)
        printf '%d %d %d' "0x${BASH_REMATCH[1]:0:2}" "0x${BASH_REMATCH[2]:0:2}" "0x${BASH_REMATCH[3]:0:2}"
    else
        error "Could not understand colour picker output: $out"
    fi
}

# -----------------------------------------------------------------------------
# Presets
# -----------------------------------------------------------------------------

preset_temp() {
    case "$1" in
        warmest) echo 2200 ;;
        warm)    echo 2700 ;;
        day)     echo 4500 ;;
        cool)    echo 6500 ;;
        night)   echo 2200 ;;
        *) error "Unknown preset '$1' (warmest, warm, day, cool, night)" ;;
    esac
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

ACTION=""
BRIGHTNESS=""
TEMP=""
RGB=""
PRESET=""

need_value() {
    [[ $# -ge 2 && "$2" != --* ]] || error "$1 requires a value"
}

set_action() {
    [[ -z "$ACTION" ]] || error "Only one of --on, --off, --toggle, --status, --pick, --preset can be used"
    ACTION="$1"
}

[[ $# -gt 0 ]] || { usage; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --on|--off|--toggle|--status|--pick)
            set_action "${1#--}"; shift ;;
        --preset)
            need_value "$@"; set_action preset; PRESET="$2"; shift 2 ;;
        --brightness)
            need_value "$@"; BRIGHTNESS="$2"; shift 2 ;;
        --temp)
            need_value "$@"; TEMP="$2"; shift 2 ;;
        --rgb)
            [[ $# -ge 4 ]] || error "--rgb requires R G B"
            RGB="$2 $3 $4"; shift 4 ;;
        --hex)
            need_value "$@"; RGB=$(hex_to_rgb "$2"); shift 2 ;;
        --ip)
            need_value "$@"; BULB_IP="$2"; shift 2 ;;
        --port)
            need_value "$@"; BULB_PORT="$2"; shift 2 ;;
        -h|--help)
            usage; exit 0 ;;
        *)
            error "Unknown option: $1" ;;
    esac
done

[[ -n "$ACTION$BRIGHTNESS$TEMP$RGB" ]] || { usage; exit 1; }

validate_ip "$BULB_IP"
require_int_range "Port" "$BULB_PORT" 1 65535

# -----------------------------------------------------------------------------
# Build the request
# -----------------------------------------------------------------------------

if [[ -n "$BRIGHTNESS" ]]; then
    require_int_range "Brightness" "$BRIGHTNESS" 0 "$DIM_MAX"
    ((BRIGHTNESS < DIM_MIN)) && BRIGHTNESS=$DIM_MIN
    PARAMS[dimming]=$BRIGHTNESS
fi

if [[ -n "$TEMP" ]]; then
    require_int_range "Temperature" "$TEMP" "$TEMP_MIN" "$TEMP_MAX"
    [[ -z "$RGB" ]] || error "--temp cannot be combined with a colour"
    PARAMS[temp]=$TEMP
fi

case "$ACTION" in
    status)
        get_state
        echo
        exit 0
        ;;
    off)
        [[ -z "$BRIGHTNESS$TEMP$RGB" ]] || error "--off cannot be combined with other changes"
        PARAMS[state]=false
        ;;
    toggle)
        [[ -z "$BRIGHTNESS$TEMP$RGB" ]] || error "--toggle cannot be combined with other changes"
        current=$(get_state)
        if [[ "$(json_get "$current" state || echo false)" == true ]]; then
            ACTION=off
            PARAMS[state]=false
        else
            ACTION=on
        fi
        ;;
    pick)
        RGB=$(pick_colour)
        ;;
    preset)
        [[ -z "$TEMP$RGB" ]] || error "--preset cannot be combined with --temp or a colour"
        PARAMS[temp]=$(preset_temp "$PRESET")
        if [[ -z "$BRIGHTNESS" ]]; then
            if [[ "$PRESET" == night ]]; then
                PARAMS[dimming]=$NIGHT_DIMMING
            else
                # Leaving night mode: restore full brightness. Otherwise keep
                # whatever brightness the bulb currently has.
                current=$(get_state)
                dimming=$(json_get "$current" dimming || echo "$DIM_MAX")
                if ((dimming <= NIGHT_DIMMING)); then
                    PARAMS[dimming]=$DIM_MAX
                fi
            fi
        fi
        ;;
esac

if [[ -n "$RGB" ]]; then
    read -r R G B <<<"$RGB"
    require_int_range "Red" "$R" 0 255
    require_int_range "Green" "$G" 0 255
    require_int_range "Blue" "$B" 0 255
    PARAMS[r]=$R
    PARAMS[g]=$G
    PARAMS[b]=$B
fi

# Everything except --off implies the bulb should be on.
[[ "$ACTION" == off ]] || PARAMS[state]=true

apply_and_verify

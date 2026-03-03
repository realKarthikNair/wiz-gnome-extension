#!/bin/bash

# Simple bash script to toggle WiZ smart bulbs on/off
# Usage: ./toggle-lights.sh --on
#        ./toggle-lights.sh --off
#        ./toggle-lights.sh --on --ip 192.168.1.50
#        ./toggle-lights.sh --toggle

BULB_IP=${BULB_IP:-"192.168.1.11"}  # Set default or use env var
PORT=38899

# Parse arguments
ACTION=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --on)
            ACTION="on"
            shift
            ;;
        --off)
            ACTION="off"
            shift
            ;;
        --toggle)
            ACTION="toggle"
            shift
            ;;
        --ip)
            BULB_IP="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--on|--off|--toggle] [--ip <IP_ADDRESS>]"
            exit 1
            ;;
    esac
done

if [ -z "$ACTION" ]; then
    echo "Error: Please specify --on, --off, or --toggle"
    echo "Usage: $0 [--on|--off|--toggle] [--ip <IP_ADDRESS>]"
    exit 1
fi

# Send command via UDP using nc (netcat)
send_command() {
    local state=$1
    local msg="{\"method\":\"setState\",\"id\":1,\"params\":{\"state\":$state}}"
    echo "$msg" | nc -u -w0 "$BULB_IP" "$PORT" 2>/dev/null
    if [ $? -eq 0 ]; then
        status=$([ "$state" = "true" ] && echo "ON" || echo "OFF")
        echo "✓ Light turned $status ($BULB_IP)"
    else
        echo "✗ Failed to send command to $BULB_IP:$PORT"
        echo "  Make sure the bulb IP is correct and the bulb is reachable"
        exit 1
    fi
}

# Execute action
case $ACTION in
    on)
        send_command "true"
        ;;
    off)
        send_command "false"
        ;;
    toggle)
        # For toggle, we'd need to query the bulb state first
        # For now, we'll just alternate (requires state persistence)
        echo "Toggle requires state tracking. Use --on or --off instead."
        exit 1
        ;;
esac

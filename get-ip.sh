#!/bin/bash
# Detects the machine's LAN IP and prints the full Playwright connection URL
# Run this ON the remote machine after starting the Docker container

# Try common interfaces: en0 (Mac Wi-Fi), en1 (Mac Ethernet), eth0 (Linux)
IP=$(ipconfig getifaddr en0 2>/dev/null || \
     ipconfig getifaddr en1 2>/dev/null || \
     hostname -I 2>/dev/null | awk '{print $1}')

if [ -z "$IP" ]; then
    echo ""
    echo "  Could not auto-detect IP."
    echo "  Run manually: ipconfig getifaddr en0"
    exit 1
fi

echo ""
echo "======================================================"
echo "  Playwright Server is running!"
echo "======================================================"
echo ""
echo "  Connection URL:  ws://$IP:9222"
echo ""
echo "  Run this on your LOCAL machine:"
echo ""
echo "  pytest -m signIn --remote-ws-url ws://$IP:9222"
echo ""
echo "======================================================"
echo ""

#!/bin/bash
# Queries the ngrok dashboard API to get the public tunnel URL
# Run this on the remote machine after 'docker compose up -d'

echo ""
echo "Waiting for ngrok tunnel to be ready..."
sleep 4

URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import sys, json
data = json.load(sys.stdin)
tunnels = data.get('tunnels', [])
https_tunnel = next((t for t in tunnels if t['proto'] == 'https'), None)
if https_tunnel:
    print(https_tunnel['public_url'])
" 2>/dev/null)

if [ -z "$URL" ]; then
    echo ""
    echo "  ERROR: Could not get ngrok URL."
    echo "  Check if containers are running: docker compose ps"
    echo "  Check ngrok logs: docker compose logs ngrok"
    exit 1
fi

# Convert https:// to wss:// for Playwright WebSocket connection
WS_URL="${URL/https/wss}"

echo ""
echo "======================================================"
echo "  Playwright Server is accessible!"
echo "======================================================"
echo ""
echo "  Run this on your LOCAL machine:"
echo ""
echo "  pytest -m signIn --remote-ws-url $WS_URL"
echo ""
echo "======================================================"
echo ""

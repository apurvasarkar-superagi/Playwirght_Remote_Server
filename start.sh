#!/bin/bash
echo ""
echo "=================================="
echo "  Playwright Browser Server"
echo "  Listening on port 9222"
echo "=================================="
echo ""
echo "  Run './get-url.sh' to get the"
echo "  full connection URL for your"
echo "  local machine."
echo ""

exec playwright run-server --port 9222 --host 0.0.0.0

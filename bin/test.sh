#!/bin/bash

# LLM CLI Gateway Test Script
# Usage: ./bin/test.sh [MODEL_NAME]

MODEL=${1:-"coder-model"}
GATEWAY_URL="http://localhost:3000/v1/chat/completions"

echo "--------------------------------------------------"
echo "Testing LLM CLI Gateway..."
echo "Target Model: $MODEL"
echo "Target URL:   $GATEWAY_URL"
echo "--------------------------------------------------"

echo -e "\n[1/2] Testing Non-Streaming (JSON) Response..."
RESPONSE=$(curl -s -X POST "$GATEWAY_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Hello, what is your name?\"}],
    \"stream\": false
  }")

if [[ $RESPONSE == *"content"* ]]; then
    echo "✅ Success!"
    echo "Reply: $(echo $RESPONSE | grep -o '"content":"[^"]*"' | head -1)"
else
    echo "❌ Failed!"
    echo "Full Response: $RESPONSE"
fi

echo -e "\n[2/2] Testing Streaming (SSE) Response..."
echo "Waiting for stream..."
curl -s -X POST "$GATEWAY_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Count to 3.\"}],
    \"stream\": true
  }" | head -n 10

echo -e "\n--------------------------------------------------"
echo "Test Session Complete."

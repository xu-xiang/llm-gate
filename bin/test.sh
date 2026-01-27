#!/bin/bash

# LLM CLI Gateway Test Script
# Usage: ./bin/test.sh [MODEL_NAME] [API_KEY]

MODEL=${1:-"coder-model"}
API_KEY=${2:-""}
BASE_URL="http://localhost:3000/v1"

AUTH_HEADER=""
if [ ! -z "$API_KEY" ]; then
    AUTH_HEADER="-H \"Authorization: Bearer $API_KEY\""
fi

echo "--------------------------------------------------"
echo "Testing LLM CLI Gateway..."
echo "Target Model: $MODEL"
echo "Base URL:     $BASE_URL"
echo "--------------------------------------------------"

echo -e "\n[1/3] Testing Non-Streaming (JSON) Response..."
CMD="curl -s -X POST \"$BASE_URL/chat/completions\" \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d '{ \
    \"model\": \"$MODEL\", \
    \"messages\": [{\"role\": \"user\", \"content\": \"Hello, what is your name?\"}], \
    \"stream\": false \
  }'"
RESPONSE=$(eval $CMD)

if [[ $RESPONSE == *"content"* ]]; then
    echo "✅ Chat Success!"
    echo "Reply: $(echo $RESPONSE | grep -o '"content":"[^"]*"' | head -1)"
else
    echo "❌ Chat Failed!"
    echo "Full Response: $RESPONSE"
fi

echo -e "\n[2/3] Testing Streaming (SSE) Response..."
echo "Waiting for stream..."
eval "curl -s -X POST \"$BASE_URL/chat/completions\" \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d '{ \
    \"model\": \"$MODEL\", \
    \"messages\": [{\"role\": \"user\", \"content\": \"Count to 3.\"}], \
    \"stream\": true \
  }'" | head -n 10

echo -e "\n[3/3] Testing Web Search Tool..."
CMD_SEARCH="curl -s -X POST \"$BASE_URL/tools/web_search\" \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d '{ \
    \"query\": \"北京今天天气\" \
  }'"
SEARCH_RES=$(eval $CMD_SEARCH)

if echo "$SEARCH_RES" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    echo "✅ Search Success!"
    echo "Results count: \n $SEARCH_RES"
else
    echo "❌ Search Failed!"
    echo "Full Response: $SEARCH_RES"
fi

echo -e "\n--------------------------------------------------"
echo "Test Session Complete."

#!/bin/bash

# LLM CLI Gateway 一键重启脚本

echo "--------------------------------------------------"
echo "🚀 Starting LLM CLI Gateway Restart Process..."
echo "--------------------------------------------------"

# 1. 停止旧进程
echo "Stopping existing gateway processes..."
# 查找运行 index.js 的 node 进程并结束它
PID=$(pgrep -f "dist/index.js")
if [ -n "$PID" ]; then
    echo "Killing process $PID"
    kill $PID
    sleep 1
fi

# 2. 清理旧产物
echo "Cleaning up dist folder..."
rm -rf dist/

# 3. 重新编译
echo "Compiling TypeScript..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Compilation failed! Aborting."
    exit 1
fi

# 4. 启动服务
echo "Starting service in background..."
nohup node dist/index.js > server.log 2>&1 &

# 5. 等待启动并检查
sleep 2
NEW_PID=$(pgrep -f "dist/index.js")
if [ -n "$NEW_PID" ]; then
    echo "✅ Gateway started successfully (PID: $NEW_PID)"
    echo "Monitor it at: http://localhost:3000/"
    echo "Logs are being written to server.log"
else
    echo "❌ Failed to start service. Check server.log for details."
    tail -n 20 server.log
fi

echo "--------------------------------------------------"

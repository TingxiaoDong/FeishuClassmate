#!/usr/bin/env bash
# ClassmateOS 新栈开发启动脚本：后端、Agent 网关和可选 Temi 侧车。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

LOG_DIR="./logs"
mkdir -p "${LOG_DIR}"

PIDS=()
cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do
    kill "${pid}" 2>/dev/null || true
  done
  exit "${code}"
}
trap cleanup EXIT INT TERM

pnpm classmateos >"${LOG_DIR}/classmateos.log" 2>&1 &
PIDS+=("$!")
pnpm classmate gateway >"${LOG_DIR}/agent-gateway.log" 2>&1 &
PIDS+=("$!")

if [ "${TEMI_ENABLED:-0}" = "1" ] && [ -d "./temi-sidecar" ]; then
  (cd ./temi-sidecar && python3 -m uvicorn server:app --host 127.0.0.1 --port 8091) >"${LOG_DIR}/temi-sidecar.log" 2>&1 &
  PIDS+=("$!")
fi

printf 'ClassmateOS 新栈已启动。\n'
printf '后端日志：%s\n' "${LOG_DIR}/classmateos.log"
printf 'Agent 日志：%s\n' "${LOG_DIR}/agent-gateway.log"
wait

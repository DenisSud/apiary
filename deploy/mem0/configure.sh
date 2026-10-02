#!/usr/bin/env bash
# Replay the canonical mem0 configuration. Run after every fresh deploy:
# the overrides live in Postgres and are lost with the database.
#
#   MEM0_ADMIN_API_KEY=... ./configure.sh
#
# Env: MEM0_URL (default http://127.0.0.1:8888), OLLAMA_BASE_URL,
#      MEM0_LLM_MODEL, MEM0_EMBEDDER_MODEL, MEM0_EMBED_DIMS.
#
# Why every field: the LLM must run with reasoning off (thinking consumes the
# token budget on Ollama), and the embedder + vector store dims must match the
# embedder model — pgvector table dimensions freeze at first insert.
set -euo pipefail

base="${MEM0_URL:-http://127.0.0.1:8888}"
admin="${MEM0_ADMIN_API_KEY:?MEM0_ADMIN_API_KEY is required}"
ollama="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
llm_model="${MEM0_LLM_MODEL:-qwen3.5:4b}"
embedder_model="${MEM0_EMBEDDER_MODEL:-nomic-embed-text-v2-moe}"
dims="${MEM0_EMBED_DIMS:-768}"

payload=$(
  cat <<EOF
{
  "version": "v1.1",
  "vector_store": { "provider": "pgvector", "config": { "embedding_model_dims": $dims } },
  "llm": {
    "provider": "openai",
    "config": {
      "model": "$llm_model",
      "openai_base_url": "$ollama",
      "is_reasoning_model": true,
      "reasoning_effort": "none"
    }
  },
  "embedder": {
    "provider": "openai",
    "config": {
      "model": "$embedder_model",
      "openai_base_url": "$ollama",
      "embedding_dims": $dims
    }
  }
}
EOF
)

curl -fsS -X POST "$base/configure" \
  -H "X-API-Key: $admin" -H 'Content-Type: application/json' \
  -d "$payload" >/dev/null
echo "configure: applied (llm=$llm_model, embedder=$embedder_model, dims=$dims)"
curl -fsS "$base/configure" -H "X-API-Key: $admin" | head -c 500
echo

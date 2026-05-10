curl -s -X POST http://localhost:7100/mcp/invoke \
  -H "Authorization: Bearer demo-bearer-token-must-be-min-16-chars" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What time is it?",
    "tools": [
      {
        "name": "current_time",
        "description": "Returns the current ISO-8601 UTC timestamp.",
        "input_schema": { "type": "object", "properties": {} },
        "execution_target": "LOCAL"
      }
    ],
    "modelConfig": {
      "provider": "mock",
      "model": "mock-fast"
    },
    "runContext": {
      "traceId": "trace-test-1234"
    }
  }' | jq

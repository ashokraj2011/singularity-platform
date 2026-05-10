curl -s -X POST http://localhost:7100/mcp/invoke \
  -H "Authorization: Bearer demo-bearer-token-must-be-min-16-chars" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Page the admin about a critical database failure.",
    "tools": [
      {
        "name": "notify_admin",
        "description": "Send a high-priority notification to the on-call admin. Approval-gated.",
        "input_schema": {
          "type": "object",
          "properties": {
            "subject": { "type": "string" },
            "body": { "type": "string" }
          },
          "required": ["subject"]
        },
        "execution_target": "LOCAL",
        "requires_approval": true
      }
    ],
    "modelConfig": {
      "provider": "mock",
      "model": "mock-fast"
    },
    "runContext": {
      "traceId": "trace-test-approval-999"
    }
  }' | jq

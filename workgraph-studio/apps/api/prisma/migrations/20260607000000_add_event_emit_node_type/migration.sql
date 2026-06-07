-- EVENT_EMIT node type: publish a workflow event to a configurable sink
-- (internal eventbus / Kafka / SQS / SNS / AMQP). Mirrors the RUN_PYTHON
-- enum-extension migration. IF NOT EXISTS keeps re-runs idempotent.
ALTER TYPE "NodeType" ADD VALUE IF NOT EXISTS 'EVENT_EMIT';

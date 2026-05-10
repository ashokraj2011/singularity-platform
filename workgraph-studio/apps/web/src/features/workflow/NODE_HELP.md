# Workflow Node Types Guide

This guide explains each node type in the Workflow Designer and when to use them.

---

## Core Task Nodes

### **Human Task** 🧑
**What it does:** Assigns work to a person that requires human decision or action.

**When to use:** When you need a human to manually complete something — review documents, approve decisions, enter data, etc.

**Configuration:**
- **Assignee (email)** — who receives the task
- **Role** — filter by role (optional, e.g., "analyst")
- **Due in (days)** — how many days before task is overdue
- **Priority** — HIGH, MEDIUM, or LOW

**Output:** Task stored in database, available in Runtime tab. Human completes via task interface; workflow advances when marked done.

---

### **Agent Task** 🤖
**What it does:** Delegates work to an AI agent (from agent registry or internal store).

**When to use:** For automated decision-making, summarization, data extraction, content generation — anything an LLM can handle.

**Configuration:**
- **Agent ID** — which agent to invoke (picked from agent registry or internal agents)
- **Model override** — use a different model than the agent's default (e.g., claude-opus-4-7)
- **Prompt hint** — additional context or instruction for this specific run
- **Max tokens** — cap on output length

**Output:** Agent runs asynchronously. Result stored in workflow context. Downstream nodes see `output.agentResponse`. **Note:** Agent output requires human review before promotion to next stage in v1.

---

### **Approval** ✓
**What it does:** Pauses the workflow until someone explicitly approves or rejects.

**When to use:** For critical gates — before publishing, before charging a customer, before sending emails, etc.

**Configuration:**
- **Approver (email)** — who can approve/reject
- **Min approvals** — how many approvals needed (for multi-person gates)
- **Due in (days)** — escalate if no response
- **Escalate to** — who to notify if approval is delayed

**Output:** Approval request created in database. If rejected, workflow can branch. If approved, advances.

---

## Branching & Control Nodes

### **Decision Gate** (XOR) 🔀
**What it does:** Evaluates a condition and routes the workflow down ONE path.

**When to use:** If-then logic — "if score > 0.8, proceed to publish; else, send to review."

**Configuration:**
- **Condition** — JavaScript expression (e.g., `output.score > 0.8`, `context.status == "active"`)
- **True branch label** — label for the outgoing edge if condition is true
- **False branch label** — label for the outgoing edge if condition is false

**Output:** Evaluates immediately. Both branches are drawn; at runtime, only the true branch executes.

---

### **Parallel Fork** (AND-split) 🔱
**What it does:** Splits the workflow into multiple concurrent branches.

**When to use:** Run multiple tasks in parallel — send email AND update CRM AND log event, all at the same time.

**Configuration:**
- **Expected branches** — informational; helps you remember how many parallel paths follow

**Output:** All outgoing edges fire simultaneously (regardless of conditions). Workflow advances down all branches at once.

---

### **Parallel Join** (AND-join) 🔀
**What it does:** Waits until ALL incoming parallel branches have completed before proceeding.

**When to use:** Synchronization point after parallel work — "continue only after all 3 branches finish."

**Configuration:**
- **Expected branches** — how many parallel paths are converging (e.g., 2 or 3)

**Output:** Holds the workflow. When the last parallel branch arrives, the join node completes and workflow advances to the next stage.

---

### **Inclusive Gateway** (OR) 📊
**What it does:** Routes the workflow down ALL outgoing branches whose conditions are true.

**When to use:** Multiple non-exclusive conditions — "send to support AND log to Datadog AND create a task (all if applicable)."

**Configuration:**
- (No standard fields; use edge conditions)

**Output:** All edges with true conditions fire. Unlike Decision Gate, multiple branches can activate.

---

### **Event Gateway** ⚡
**What it does:** First-to-fire gate — whichever downstream SIGNAL_WAIT or TIMER fires first wins; others are cancelled.

**When to use:** Race conditions — "wait for either customer approval (signal) or timeout (timer), whichever comes first."

**Configuration:**
- **Global timeout** — if you want a safety net (e.g., "give up after 5 minutes")

**Output:** One branch executes; the rest are skipped.

---

## Data & State Nodes

### **Set Context** 📝
**What it does:** Writes or updates variables in the workflow context that downstream nodes can read.

**When to use:** Transform data, compute intermediate values, prepare inputs for next steps.

**Configuration:**
- **Context Assignments** — repeating key-value pairs:
  - **Key** = context path (e.g., `customer.tier`, `order.total`)
  - **Value** = literal (e.g., `"GOLD"`) or `{{ reference.path }}` to copy from another context value

**Output:** Context updated immediately. All downstream nodes see the new values.

**Example:** 
```
path: customer.tier    value: "GOLD"
path: order.discount   value: {{ context.customer.loyalty }}
path: is_eligible      value: true
```

---

### **Data Sink** 💾
**What it does:** Writes workflow output to external systems — database, Connector (Jira, S3), or an artifact.

**When to use:** Persist results — save decision to database, attach file to Jira, create versioned artifact, etc.

**Configuration:**
- **Kind** — CONNECTOR (Jira, S3, email), DB_EVENT (write to database), or ARTIFACT (versioned output)
- **For CONNECTOR:** connector ID, operation name, input mappings
- **For DB_EVENT:** event type, payload
- **For ARTIFACT:** artifact type, title, content path

**Output:** Data written. Workflow continues.

---

### **Error Catch** 🛑
**What it does:** Catches failures from upstream nodes and defines a fallback path.

**When to use:** Error recovery — if tool request fails, notify a human; if API call times out, retry manually.

**Configuration:**
- **Catch error code** — optional filter (blank = catch all errors)
- **Context path** — where to store error info (default: `_error`)

**Output:** Error info written to context. Fallback path activates.

**How to use:** Draw an `ERROR_BOUNDARY` edge (not a regular sequential edge) from the failing node to this catch node. When that node fails, the Error Catch node activates instead of failing the workflow.

---

## Async & Timing Nodes

### **Signal Wait** 📻
**What it does:** Pauses the workflow and waits for an external signal to arrive.

**When to use:** External events — wait for customer to confirm, wait for webhook callback, wait for manual approval outside the system.

**Configuration:**
- **Signal name** — unique name to listen for (e.g., `"customer_confirmed"`)
- **Correlation key** — optional; allows scoping signals to specific instances (e.g., `"order_id"`)

**Output:** Node stays ACTIVE until external POST `/workflow-instances/:id/signals/customer_confirmed` is called. Then advances.

---

### **Signal Emit** 📡
**What it does:** Broadcasts a named signal, waking any SIGNAL_WAIT nodes listening for it.

**When to use:** Inter-workflow communication — one workflow emits "order_ready", another workflow's Signal Wait wakes up.

**Configuration:**
- **Signal name** — which signal to broadcast
- **Correlation key** — optional; if set, only wakes SIGNAL_WAIT nodes with matching correlation
- **Payload path** — optional context path to send as signal payload

**Output:** Auto-advances after emitting.

**Example:** Workflow A emits `"order_ready"` → Workflow B's Signal Wait (`"order_ready"`) wakes up and continues.

---

### **Timer** ⏱
**What it does:** Pauses the workflow for a fixed duration or until a specific time.

**When to use:** Delays — wait 30 seconds before retry, schedule task for next morning, rate-limit actions.

**Configuration:**
- **Duration** — human-readable (e.g., `"30s"`, `"5m"`, `"2h"`)
- **Duration (ms)** — milliseconds (e.g., `60000`)
- **Until (ISO time)** — specific datetime (e.g., `"2026-05-01T09:00:00Z"`)

**Output:** Fires automatically when time elapses. Workflow continues.

---

## Task & Execution Nodes

### **For Each** 🔄
**What it does:** Loops over a collection and runs the same branch once per item.

**When to use:** Process lists — send email to 50 customers, create a Jira ticket for each bug, etc.

**Configuration:**
- **Collection path** — context path to the array (e.g., `"customers"`)
- **Item variable** — what to call each item (e.g., `"customer"`)
- **Parallel** — true/false; run all iterations at once or sequentially
- **Max concurrency** — if parallel, limit to N concurrent iterations

**Output:** Edges after For Each loop are duplicated per item. Downstream nodes see `{{ context.customer }}` (or your item variable).

---

### **Call Sub-Workflow** 🔗
**What it does:** Spawns a child workflow from a template and waits for it to complete.

**When to use:** Reusable workflows — "run the email-validation workflow for this customer."

**Configuration:**
- **Template ID** — which template to instantiate
- **Version** — which version of the template (optional)

**Output:** Child workflow created and run. Parent waits. When child completes (or fails), parent continues with child's result in context.

---

### **Tool Request** 🔧
**What it does:** Invokes an external tool (from tool registry) with policy enforcement.

**When to use:** API calls, integrations — send SMS, query database, call LLM Gateway, etc.

**Configuration:**
- **Tool name** — which tool (picked from tool registry)
- **Action name** — which action within that tool (e.g., "send" for an email tool)
- **Risk level** — LOW, MEDIUM, HIGH, CRITICAL (for audit/policy)

**Output:** Tool runs. Result stored in context. **Note:** High-risk tools may require approval before execution.

---

### **Policy Check** 🛡
**What it does:** Evaluates a named policy (e.g., "spend limit", "data residency") before proceeding.

**When to use:** Compliance gates — check if order total is within spending cap, check if customer is in approved region, etc.

**Configuration:**
- **Policy name** — name of the policy to evaluate (e.g., `"spend_limit"`)
- **On failure** — BLOCK (stop workflow), WARN (log but continue), LOG (silent)

**Output:** If approved, advances. If blocked, workflow stops (unless you draw a fallback path).

---

### **Create Artifact** 📦
**What it does:** Produces a versioned, typed output (e.g., a report, document, or dataset).

**When to use:** Generate outputs that should be reviewed and versioned — campaign brief, customer segmentation, analysis report.

**Configuration:**
- **Artifact type** — what kind of artifact (e.g., `"CampaignBrief"`, `"SegmentList"`)
- **Version** — version number (e.g., `"1.0"`, `"2.1"`)
- **Requires approval** — true/false; must be explicitly approved before use

**Output:** Artifact stored. If approval required, workflow pauses until human reviews and approves.

---

## Best Practices

1. **Always name your nodes** — Use descriptive labels so other users understand the flow.

2. **Use Data Sink for persistence** — Don't rely on workflow context alone; write results to external systems or artifacts.

3. **Handle errors with Error Catch** — Draw ERROR_BOUNDARY edges to recovery nodes (Human Task, Set Context, etc.) to gracefully handle failures.

4. **Leverage Parallel Fork/Join for concurrency** — Run independent work in parallel, then sync at a Join node.

5. **Document signal names** — If using Signal Wait/Emit, document which signals are used and their contract.

6. **Test with sample data** — Before running on production data, test the workflow with small, safe datasets.

7. **Monitor execution** — Check the Runtime tab to see node status, outputs, and errors as the workflow runs.

8. **Archive old versions** — Keep templates clean; archive versions you no longer use.

---

## Execution States

Every node passes through these states:

- **PENDING** — Not yet reached in the workflow.
- **ACTIVE** — Currently executing or waiting (e.g., Human Task awaiting input).
- **COMPLETED** — Finished successfully.
- **FAILED** — Error occurred and not recovered.
- **SKIPPED** — Not executed (e.g., condition evaluated to false).
- **BLOCKED** — Waiting on an external dependency (policy, approval).

Check the Runtime tab to see each node's current state and any error messages.

---

## Tips

- **For-Each + Human Task:** Assign a task to each customer in a list.
- **Decision Gate → Data Sink:** Route to different output destinations based on a decision.
- **Timer + Signal Wait:** Implement a timeout — "wait for approval, but give up after 2 hours."
- **Call Sub-Workflow + Parallel Fork:** Run the same sub-workflow on multiple inputs in parallel, then join.
- **Tool Request + Error Catch:** Try an API call; if it fails, notify a human via Human Task in the catch handler.

---

**Questions?** Check the node's description in the NodeInspector panel, or ask in the Audit Log (events are logged for all node executions).

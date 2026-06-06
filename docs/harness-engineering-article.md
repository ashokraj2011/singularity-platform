# Harness Engineering: How We Build Deterministic Benchmarks for Stochastic Coding Agents

*Published by the Singularity Platform Engineering Team*

---

## 1. Introduction: The Stochastic Agent Paradox

Building autonomous software engineering agents (like those powered by `context-fabric`) presents a fundamental engineering paradox: **How do you build a deterministic test suite for an engine that is inherently non-deterministic?**

Large Language Models (LLMs) are stochastic. A minor modification in a system prompt, a change in tool descriptions, or a model version upgrade (e.g., swapping a minor Claude 3.5 revision) might fix a bug in repository A, but silently degrade performance on repository B. Traditional unit tests fail to capture these regressions because:
1. They evaluate isolated code blocks, not the multi-turn reasoning path of the agent.
2. Running live agent code edits in a real sandbox on every git commit is slow and cost-prohibitive.

To solve this, we implemented **Harness Engineering** in `context-fabric`—an offline evaluation, simulation, and benchmark testing layer that wraps stochastic LLMs inside strict, mathematical scoring, regression, and chaos-testing harnesses.

---

## 2. The Architecture of the Singularity Test Harness

We deploy three distinct harnesses across the platform to evaluate different layers of the agentic loop:

```
                      +------------------------------------------+
                      |          SINGULARITY TESTING             |
                      +------------------------------------------+
                                           |
         +---------------------------------+---------------------------------+
         |                                 |                                 |
+--------------------------+    +--------------------------+    +--------------------------+
| 1. OFFLINE BENCHMARK     |    | 2. IN-PROCESS EVALS      |    | 3. CHAOS HARNESS         |
|                          |    |                          |    |                          |
| Runs live tasks through  |    | Mock-runs governed_step  |    | Injects mock 429/503/529 |
| execute-governed-stage.  |    | to benchmark transitions |    | to test loop resilience. |
| Scores via 3 oracles.    |    | with zero API latency.   |    |                          |
+--------------------------+    +--------------------------+    +--------------------------+
```

---

## 3. Deep Dive: The Offline Capability Benchmark (`tools/capability-harness`)

The primary testing engine is the **Capability Harness** (located at [`tools/capability-harness/`](file:///Users/ashokraj/Downloads/backupSingularity/singularity-platform/tools/capability-harness/)). It plays a fixed corpus of real-world bug-fixing tasks through `context-fabric`'s live `/execute` endpoint and scores results using **three independent oracles**.

### The Three-Oracle Voting System
To prevent false negatives (e.g., an agent writes perfectly correct code but styles it differently than the reference patch), the harness implements a majority-vote consensus: **a task passes if at least 2 of the 3 oracles vote "pass."**

#### Oracle 1: Whitespace-Normalized Jaccard Token Overlap
*   **Purpose**: A cheap and fast string comparison to check if the agent produced code that resembles the baseline reference.
*   **Logic**: Collapses all spaces, tabs, and line breaks into single spaces, extracts individual tokens, and calculates the **Jaccard similarity index** (intersection over union):
    $$J(A, B) = \frac{|A \cap B|}{|A \cup B|}$$
*   **Implementation** ([`scoring.py`](file:///Users/ashokraj/Downloads/backupSingularity/singularity-platform/tools/capability-harness/scoring.py#L76-L140)):
    ```python
    def _normalise_for_diff(text: str) -> str:
        return re.sub(r"\s+", " ", text or "").strip()

    def oracle_diff_matches_reference(*, agent_output: str, reference_patch: str, min_overlap_ratio: float = 0.75) -> OracleResult:
        norm_agent = _normalise_for_diff(agent_output)
        norm_ref = _normalise_for_diff(reference_patch)
        
        agent_lines = {line.strip() for line in norm_agent.split(" ") if line.strip()}
        ref_lines = {line.strip() for line in norm_ref.split(" ") if line.strip()}
        
        intersection = len(agent_lines & ref_lines)
        union = len(agent_lines | ref_lines)
        ratio = intersection / union if union else 0.0
        passed = ratio >= min_overlap_ratio
        return OracleResult(name="diff_matches_reference", passed=passed, score=ratio)
    ```

#### Oracle 2: Rubric-Driven LLM Judge
*   **Purpose**: Catches semantic correctness (i.e. the agent's logic is correct but structured differently than the reference).
*   **Logic**: System prompt defines a strict 1-5 evaluation rubric. An LLM-as-a-judge compares the agent's changes against the baseline reference, returning a structured JSON response. A score $\ge 3$ counts as a pass.

#### Oracle 3: Sandbox Test Execution
*   **Purpose**: The ultimate validation of code functionality.
*   **Logic**: Spawns an isolated Python/TS workspace runner ([`sandbox.py`](file:///Users/ashokraj/Downloads/backupSingularity/singularity-platform/tools/capability-harness/sandbox.py)), applies the agent's edits, executes the test suite, and captures exit codes and stack traces.

---

## 4. Statistics-Based Regression Guarding

When run in a CI/CD cron pipeline, the harness does not just output numbers; it actively detects pass-rate degradation using [`regression.py`](file:///Users/ashokraj/Downloads/backupSingularity/singularity-platform/tools/capability-harness/regression.py).

### The Trailing-Window Baseline
Instead of comparing the latest run solely to the immediate previous run (which causes alert spam due to minor LLM temperature variance), the regression guard calculates a **trailing-window mean** across the last $N$ runs (default: 4):

$$\mu_{\text{baseline}} = \frac{1}{N} \sum_{i=1}^{N} \text{pass\_rate}_{i}$$

If the current pass rate falls below the baseline by more than a threshold $\theta$ (default: 5% absolute drop), it flags a regression:

$$\mu_{\text{baseline}} - \text{pass\_rate}_{\text{current}} \ge \theta$$

When a regression is detected, the script fires a `capability.bench_regression_alert` event to the platforms central audit service, notifying the team immediately.

---

## 5. Chaos Injection Harnessing

To verify the resilience of the outer agent loop (in `context-fabric`'s FastAPI engine), we engineered a **Mock Chaos Provider** inside the `llm_gateway_service` ([`providers/mock.py`](file:///Users/ashokraj/Downloads/backupSingularity/singularity-platform/context-fabric/services/llm_gateway_service/app/providers/mock.py)).

By configuring the gateway to point to chaotic model names, we simulate real-world API instability:
*   `mock-fail-429`: Simulates rate limits to verify the orchestrator's exponential backoff and retry mechanisms.
*   `mock-fail-503` / `mock-fail-529`: Simulates service overload to verify fallback model routing.
*   `mock-timeout`: Simulates connection hangs to verify context compiler thresholds.

This allows us to verify that a network glitch never causes a coding stage to fail mid-flight, but instead triggers graceful retries or human-attention flags.

---

## 6. Lessons Learned in Harness Engineering

Building these testing suites taught our team several key lessons on agent evaluation:

1.  **Keep Benchmark Code Decoupled**: The evaluation runner lives entirely outside the production execution path. This guarantees that test utilities or helper libraries can never contaminate the agent's available tool registry.
2.  **Evaluate Potential, Not Trace History**: Historical trace analysis (evaluating past logs) only tells you if the agent *was* correct. The capability harness runs *fresh* problems through the live runtime, evaluating what the agent *can* do when logic changes.
3.  **Graceful Degrade on Judge Failures**: If the LLM Judge API fails or times out, the harness is configured to fail-open (if preferred) to avoid halting developer pipelines over minor upstream LLM hiccups.

By building deterministic testing frameworks around stochastic agent loops, we moved our engineering process from "guessing if a prompt change worked" to **continuous statistical verification**.

# Metis Control

Metis coordinates tool and reasoning-effort decisions for coding clients. Its vocabulary distinguishes request and conversation changes, and the usage observed while carrying out a task.

## Language

**Tool routing**:
Selecting whether a coding client should use a tool, and which tool should be selected, for its next model response.
_Avoid_: Model routing

**Effort routing**:
Selecting the reasoning effort for the coding client's next model response without selecting a different model.
_Avoid_: Model switching

**Request pruning**:
Reducing selected tool-result content in an outgoing model request while retaining the client's original conversation.
_Avoid_: Session compaction, summarization

**Session compaction**:
Replacing a client's active conversation context with a shorter representation used by subsequent turns.
_Avoid_: Request pruning

**Duplicate baseline**:
A deterministic request-pruning strategy that removes repeated tool-result content without asking a model to judge its relevance. It provides the reference for measuring whether Jev's selection adds value.

**Model usage**:
Reported input and output tokens consumed by the coding client's model calls, including generation and session compaction.

**Evaluator usage**:
Reported input and output tokens consumed by Jev evaluations on behalf of the coding client.

**Known token total**:
The sum of reported model and evaluator input and output tokens. Cache and reasoning breakdowns are already part of those totals; missing usage remains unknown.
_Avoid_: Monetary cost, billed usage

**Partial accounting**:
An accounting result whose coverage is incomplete because some usage was not observed or retained. Its known token total does not establish the whole task's token consumption.
_Avoid_: Complete task total

**Task**:
One invocation of a coding-client wrapper, including its model calls, evaluations, tools, and user wait time. An interactive task can contain multiple user requests.
_Avoid_: User turn

**Upstream attempt**:
One dispatch of a model or evaluator request. A retry is a separate attempt; a failed attempt can still have reported usage.

**Complete accounting**:
An accounting result with observed task boundaries and reported input and output usage for every dispatched attempt, without missing history or unfinished requests. This describes measurement coverage independently of task success or output quality.

**Mixed task**:
A task whose observed requests use different routing modes, or a mode different from the one selected at launch. Its total usage cannot be attributed to a single routing mode.

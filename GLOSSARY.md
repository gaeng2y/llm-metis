# Metis Control

Metis coordinates tool and reasoning-effort decisions for coding clients. The context-retention vocabulary below distinguishes changing a model request from changing the client's conversation.

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

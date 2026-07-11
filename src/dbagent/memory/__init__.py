"""Per-run exemplar memory for the SQL agent.

Stage-1 design (see ``text2sql-agent-memory-modules_active_version.md``): store
verified ``{question -> SQL}`` exemplars in a LanceDB table, retrieve the most
similar ones from the *same* database by embedding similarity, and inject them as
few-shot references into the task prompt. Host-side only; no container changes.
"""

from .embedding import Embedder, QUERY_INSTRUCTION
from .store import MemoryStore

__all__ = ["Embedder", "MemoryStore", "QUERY_INSTRUCTION"]

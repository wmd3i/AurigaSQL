"""Host-side embedding helper for the memory module.

Follows the Qwen3-Embedding author recommendation: the *query* is embedded with a
one-sentence English instruction, while stored *documents* are embedded raw. Both
are L2-normalized so a cosine metric reduces to a dot product.

Two backends, selected by the model string:
  * ``st:<hf_id>``  -> local sentence-transformers (e.g. ``st:Qwen/Qwen3-Embedding-0.6B``).
                        Handles Qwen last-token pooling + the built-in ``query`` prompt
                        natively; no Ollama embedding endpoint required.
  * anything else   -> ``litellm.embedding`` (e.g. ``ollama/…`` against an
                        embeddings-enabled Ollama server, or a hosted provider).
"""

from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger(__name__)

# One English sentence, per the Qwen instruction-aware recipe. Applied to the
# incoming question only (the "query"), never to stored questions ("documents").
QUERY_INSTRUCTION = (
    "Given a database question, retrieve previously solved questions on the same "
    "database that use similar tables and query logic."
)

_ST_PREFIX = "st:"


class Embedder:
    """Embeds text to L2-normalized vectors. `embed_query` uses the instruction;
    `embed_document` does not."""

    def __init__(
        self,
        model: str,
        *,
        api_base: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.model = model
        self.api_base = api_base
        self.api_key = api_key
        self._use_st = model.startswith(_ST_PREFIX)
        self._st_model = None  # lazily loaded

    # -- sentence-transformers backend --------------------------------------
    def _st(self):
        if self._st_model is None:
            from sentence_transformers import SentenceTransformer

            self._st_model = SentenceTransformer(self.model[len(_ST_PREFIX):])
        return self._st_model

    def _st_encode(self, text: str, *, is_query: bool) -> list[float]:
        model = self._st()
        kwargs = {"normalize_embeddings": True, "convert_to_numpy": True}
        if is_query:
            # Prefer the model's built-in "query" prompt; fall back to a manual
            # Instruct/Query wrapper if this model has no such prompt registered.
            try:
                vec = model.encode(text, prompt_name="query", **kwargs)
            except (ValueError, KeyError):
                vec = model.encode(f"Instruct: {QUERY_INSTRUCTION}\nQuery:{text}", **kwargs)
        else:
            vec = model.encode(text, **kwargs)
        return np.asarray(vec, dtype=np.float32).tolist()

    # -- litellm backend -----------------------------------------------------
    def _litellm_encode(self, text: str) -> list[float]:
        import litellm

        resp = litellm.embedding(
            model=self.model,
            input=[text],
            api_base=self.api_base,
            api_key=self.api_key,
        )
        arr = np.asarray(resp["data"][0]["embedding"], dtype=np.float32)
        norm = float(np.linalg.norm(arr))
        if norm > 0.0:
            arr = arr / norm
        return arr.tolist()

    # -- public API ----------------------------------------------------------
    def embed_query(self, text: str) -> list[float]:
        """Embed an incoming question (the retrieval query), with instruction."""
        if self._use_st:
            return self._st_encode(text, is_query=True)
        return self._litellm_encode(f"Instruct: {QUERY_INSTRUCTION}\nQuery:{text}")

    def embed_document(self, text: str) -> list[float]:
        """Embed a stored question (a document), raw / no instruction."""
        if self._use_st:
            return self._st_encode(text, is_query=False)
        return self._litellm_encode(text)

import json
from pathlib import Path

class TrajectoryList(list):
    def __init__(self, path: str | None):
        super().__init__()
        self._path = path
        
    def _flush(self):
        if self._path:
            # TODO: should we use jsonl with true appending?
            Path(self._path).write_text(
                json.dumps(list(self), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            
    def append(self, item):
        super().append(item)
        self._flush()
            
    def extend(self, item):
        super().extend(item)
        self._flush()
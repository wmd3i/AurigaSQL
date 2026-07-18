from .dbtools import DBType

__all__ = ["DBType", "SQLAgent"]


def __getattr__(name: str):
    if name == "SQLAgent":
        from .sql_agent import SQLAgent

        return SQLAgent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

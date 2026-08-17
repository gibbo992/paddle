"""TradeBot -- a copy-trading agent that mines Moltbook for trade ideas,
forward-tests the agents making them, and tunes its own behaviour over time.

Safety posture: paper trading is the default, self-reported performance is
never trusted, and the self-improvement loop is clamped to operator-defined
hard risk limits.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]

#!/usr/bin/env python3
"""Compatibility CLI. Provider implementation is installed from Personal Radar."""
import json
import sys
from pathlib import Path
from personal_radar_connectors.telegram import worker as _worker
# Retain application policy for callers of this historical CLI path.
_worker.MONITORING_FILTERS=json.loads((Path(__file__).resolve().parents[1]/"data/telegram-monitoring-filters.json").read_text())
# Historical test imports inspect the compatibility module directly.
globals().update({name:getattr(_worker,name) for name in dir(_worker) if not name.startswith("__")})
if __name__ == "__main__":
    _worker.main()

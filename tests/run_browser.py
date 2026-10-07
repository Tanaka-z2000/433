"""Serve built output under /433/ and run all browser workflows."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

with tempfile.TemporaryDirectory(prefix='433-browser-') as directory:
    shutil.copytree('dist', Path(directory) / '433')
    server = subprocess.Popen([sys.executable, '-m', 'http.server', '8013', '--bind', '127.0.0.1', '--directory', directory], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                with urlopen('http://127.0.0.1:8013/433/', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Local preview server did not start')
        env = {**os.environ, 'PORTAL_URL': 'http://127.0.0.1:8013/433/', 'PORTFOLIO_URL':'http://127.0.0.1:8013/433/versions/v1/'}
        for script in ['tests/portal_smoke.py', 'tests/browser_smoke.py', 'tests/v2_smoke.py']:
            subprocess.run([sys.executable, script], env=env, check=True)
    finally:
        server.terminate()
        server.wait(timeout=5)

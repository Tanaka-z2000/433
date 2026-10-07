"""Serve built output under /433/ and run all browser workflows."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

port = int(os.environ.get('BROWSER_TEST_PORT', '8013'))
with tempfile.TemporaryDirectory(prefix='433-browser-') as directory:
    shutil.copytree('dist', Path(directory) / '433')
    server = subprocess.Popen([sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1', '--directory', directory], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                with urlopen(f'http://127.0.0.1:{port}/433/', timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Local preview server did not start')
        env = {**os.environ, 'PORTAL_URL': f'http://127.0.0.1:{port}/433/', 'PORTFOLIO_URL':f'http://127.0.0.1:{port}/433/versions/v1/'}
        for script in sys.argv[1:] or ['tests/portal_smoke.py', 'tests/browser_smoke.py', 'tests/v4_smoke.py', 'tests/v4_audit.py', 'tests/v4_pressure.py', 'tests/v4_lookup_smoke.py', 'tests/v4_additional_stress.py', 'tests/v4_interchange.py', 'tests/v4_adversarial.py', 'tests/v4_demo_feedback.py', 'tests/v4_allocation_reset.py']:
            subprocess.run([sys.executable, script], env=env, check=True)
    finally:
        server.terminate()
        server.wait(timeout=5)

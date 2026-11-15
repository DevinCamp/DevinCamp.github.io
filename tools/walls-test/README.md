# Walls app mock test

Renders `walls/index.html` in headless Chromium with fake Coinbase data (no network needed),
prints frame rate and console errors, and saves a screenshot.

    pip install playwright && playwright install chromium
    python run_mock.py 1400 800 0 desktop.png        # width height touch(0/1) output [k = Kalshi mode]
    python run_mock.py 393 852 1 phone.png k

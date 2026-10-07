import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

base = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8011/433/').rstrip('/') + '/'
Path('test-results').mkdir(exist_ok=True)
portfolio = {'version': 1, 'assets': [], 'cash': 12345, 'settlement': -1000,
             'flow': 0, 'cashFloor': 10, 'cashTarget': None, 'tolerance': 2}
backup = {'version': 1, 'portfolio': portfolio, 'snapshots': [
    {'id': 'legacy-test', 'name': '入口建立前的快照', 'date': '2026-10-03T00:00:00Z', 'portfolio': portfolio}
], 'evidence': []}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1080})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base, wait_until='networkidle')
    assert page.get_by_role('heading', name='可使用的版本').is_visible()
    assert page.locator('.version-card').count() == len(json.loads(Path('versions.json').read_text()))
    page.evaluate('(backup) => {localStorage.setItem("433.portfolio.v1", JSON.stringify(backup)); localStorage.setItem("433.portfolio.v2", "other-version-marker");}', backup)
    original = page.evaluate('localStorage.getItem("433.portfolio.v1")')
    page.reload(wait_until='networkidle')
    assert page.evaluate('localStorage.getItem("433.portfolio.v1")') == original
    page.screenshot(path='test-results/portal-desktop.png', full_page=True)
    page.get_by_role('link', name='進入 V1 原始版').click()
    page.wait_for_url('**/versions/v1/')
    assert page.locator('h2').all_text_contents() == ['01 現金與本次目標','02 持倉與交易限制','03 調整方案','04 情境試算','05 歷史快照']
    assert page.get_by_label('現金餘額').input_value() == '12345'
    assert page.get_by_text('入口建立前的快照', exact=True).is_visible()
    page.get_by_label('現金餘額').fill('23456')
    page.reload(wait_until='networkidle')
    assert page.get_by_label('現金餘額').input_value() == '23456'
    assert page.evaluate('localStorage.getItem("433.portfolio.v2")') == 'other-version-marker'
    page.get_by_role('link', name='返回版本入口').click()
    page.wait_for_url(base)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path='test-results/portal-mobile.png', full_page=True)
    page.get_by_role('link', name='進入 V1 原始版').click()
    assert page.get_by_label('現金餘額').input_value() == '23456'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert not errors, errors
    # The portal itself also works with JavaScript disabled.
    nojs = browser.new_context(java_script_enabled=False)
    static = nojs.new_page()
    static.goto(base)
    assert static.get_by_role('link', name='進入 V1 原始版').is_visible()
    browser.close()
print('PASS: subpath navigation, five original sections, legacy data and snapshot continuity, data isolation, mobile layout, static portal')

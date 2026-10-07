"""Check actual viewport feedback before Playwright can auto-scroll confirmation."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4')
OUT.mkdir(parents=True, exist_ok=True)
checks = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    for width, height, keyboard in [(320, 568, False), (390, 664, False), (768, 1024, False), (1440, 900, True)]:
        ctx = browser.new_context(viewport={'width': width, 'height': height}, has_touch=not keyboard)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE + 'versions/v4/', wait_until='networkidle')
        cash = page.get_by_label('現金餘額', exact=True)
        cash.fill('123456')
        page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key))?.portfolio.cash===123456', arg=KEY)
        original = page.evaluate('(key)=>localStorage.getItem(key)', KEY)
        demo = page.get_by_role('button', name='載入示範', exact=True)
        heading = page.get_by_role('heading', name='匯入預覽／確認載入資料', exact=True)
        for attempt in range(2):
            if keyboard:
                demo.focus()
                page.keyboard.press('Enter')
            else:
                demo.tap()
            # No click, focus or scroll of a preview control before these checks.
            expect(heading).to_be_in_viewport(ratio=1)
            expect(heading).to_be_focused()
            expect(page.get_by_text('尚未載入。請檢查下列內容，再按「確認載入」；取消會保留目前資料。', exact=True)).to_be_in_viewport(ratio=1)
            expect(cash).to_have_value('123456')
            assert page.evaluate('(key)=>localStorage.getItem(key)', KEY) == original
            if attempt == 0:
                page.screenshot(path=str(OUT / f'demo-preview-{width}.png'))
                if keyboard:
                    page.keyboard.press('Tab')
                    expect(page.get_by_role('button', name='確認載入', exact=True)).to_be_focused()
                    page.keyboard.press('Tab')
                    expect(page.get_by_role('button', name='取消', exact=True)).to_be_focused()
                    page.keyboard.press('Enter')
                else:
                    page.get_by_role('button', name='取消', exact=True).tap()
                expect(heading).to_have_count(0)
                expect(demo).to_be_focused()
                expect(cash).to_have_value('123456')
            else:
                page.get_by_role('button', name='確認載入', exact=True).click()
        expect(heading).to_have_count(0)
        expect(cash).to_have_value('150000')
        expect(page.locator('.status')).to_contain_text('已載入資料')
        expect(page.locator('.status')).to_be_focused()
        expect(page.locator('.status')).to_be_in_viewport(ratio=1)
        page.wait_for_function('(key)=>{const b=JSON.parse(localStorage.getItem(key));return b.portfolio.cash===150000 && b.portfolio.assets.length===2}', arg=KEY)
        page.reload()
        expect(cash).to_have_value('150000')
        assert not errors, errors
        checks.append({'viewport': f'{width}x{height}', 'input': 'keyboard' if keyboard else 'touch', 'passed': True})
        print(f'PASS: {width}x{height} visible preview, cancel, repeat, confirm, persistence', flush=True)
        ctx.close()
    browser.close()
(OUT / 'demo-feedback.json').write_text(json.dumps({'checks': checks}, ensure_ascii=False, indent=2))

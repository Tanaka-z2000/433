import os
from pathlib import Path
Path("test-results").mkdir(exist_ok=True)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(os.environ.get('PORTFOLIO_URL','http://127.0.0.1:8001/versions/v1/'),wait_until='networkidle')
    page.get_by_role('button',name='載入示範',exact=True).click()
    page.get_by_role('button',name='確認載入',exact=True).click()
    page.get_by_role('heading',name='03 調整方案').wait_for()
    assert page.get_by_text('已自動保存在此瀏覽器',exact=True).is_visible()
    assert page.locator('tbody tr').count()==2
    page.get_by_label('快照名稱').fill('瀏覽器驗證')
    page.get_by_role('button',name='保存目前快照').click()
    page.reload(wait_until='networkidle')
    assert page.get_by_text('瀏覽器驗證',exact=True).is_visible()
    page.screenshot(path='test-results/desktop.png',full_page=True)
    page.get_by_role('button',name='套用估計方案供核對').click()
    assert page.get_by_label('本次投入／提領（正投負提）').input_value()=='0'
    assert page.get_by_text('套用估計方案前',exact=True).is_visible()
    page.set_viewport_size({'width':390,'height':844})
    page.screenshot(path='test-results/mobile.png',full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'mobile overflow'
    with page.expect_download() as event:
        page.get_by_role('button',name='匯出 JSON 備份').click()
    event.value.save_as('test-results/backup.json')
    page.get_by_role('button',name='清除所有目標，僅檢查現況').click()
    assert page.get_by_label('本次現金目標 %',exact=True).input_value()==''
    page.locator('input[type=file]').set_input_files('test-results/backup.json')
    page.get_by_role('button',name='確認載入',exact=True).click()
    assert page.get_by_label('本次現金目標 %',exact=True).input_value()=='20'
    page.get_by_role('button',name='移除 00662',exact=True).click()
    page.get_by_role('button',name='移除 00675L',exact=True).click()
    assert page.get_by_role('button',name='＋ 新增標的',exact=True).is_visible()
    page.get_by_role('button',name='＋ 新增標的',exact=True).click()
    assert page.get_by_label('標的代號',exact=True).is_visible()
    page.get_by_label('現金下限 %',exact=True).fill('9')
    assert page.get_by_role('alert').is_visible()
    assert page.get_by_role('button',name='匯出 JSON 備份').is_disabled()
    assert not errors, errors
    print('PASS: demo, plan, snapshots, persistence, apply settlement, invalid input, mobile layout; no browser errors')
    browser.close()

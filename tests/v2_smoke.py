"""Exercise user-visible persistence and portfolio workflows against the built site."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8012/').rstrip('/') + '/'
url = base + 'versions/v2/'
Path('test-results').mkdir(exist_ok=True)
legacy_p = {'version': 1, 'assets': [], 'cash': 12345, 'settlement': -1000, 'flow': 0, 'cashFloor': 10, 'cashTarget': None, 'tolerance': 2}
legacy = {'version': 1, 'portfolio': legacy_p, 'snapshots': [{'id': 'legacy', 'name': '舊版快照', 'date': '2026-10-07T00:00:00Z', 'portfolio': legacy_p}], 'evidence': []}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(base)
    page.evaluate('(b) => localStorage.setItem("433.portfolio.v1", JSON.stringify(b))', legacy)
    original = page.evaluate('localStorage.getItem("433.portfolio.v1")')
    page.get_by_role('link', name='進入 V2 日常操作版').click()
    assert page.get_by_label('現金餘額', exact=True).input_value() == '0'
    assert page.locator('h2').count() == 5
    # Preview V1 import, cancel, then explicitly import to the independent V2 key.
    def upload():
        page.locator('input[type=file]').set_input_files({'name':'v1.json','mimeType':'application/json','buffer':json.dumps(legacy).encode()})
    upload()
    expect(page.get_by_text('快照 1 份', exact=False)).to_be_visible()
    page.get_by_role('button', name='取消', exact=True).click()
    assert page.get_by_label('現金餘額', exact=True).input_value() == '0'
    upload()
    page.get_by_role('button', name='確認載入', exact=True).click()
    expect(page.get_by_label('現金餘額', exact=True)).to_have_value('12345')
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    assert page.evaluate('localStorage.getItem("433.portfolio.v1")') == original
    # Count writes after loading. Rapid edits become a single durable write.
    page.evaluate('''() => {window.writeCount=0; const set=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v) {if(k==='433.portfolio.v2') window.writeCount++; return set.call(this,k,v);};}''')
    field = page.get_by_label('現金餘額', exact=True)
    field.fill('20000'); field.fill('21000'); field.fill('22000')
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    assert page.evaluate('window.writeCount') == 1
    field.fill('')
    expect(page.locator('.storage-panel')).to_contain_text('本次輸入未完整')
    assert page.evaluate('JSON.parse(localStorage.getItem("433.portfolio.v2")).portfolio.cash') == 22000
    # Reload before debounce has expired: beforeunload flushes valid input.
    field.fill('23000'); page.reload()
    expect(field).to_have_value('23000')
    # Export and recover with export status surviving reload.
    with page.expect_download() as downloaded:
        page.get_by_role('button', name='匯出 JSON 備份', exact=True).click()
    backup_path = downloaded.value.path()
    downloaded_data = json.loads(Path(backup_path).read_text())
    assert downloaded_data['version'] == 2
    expect(page.locator('.storage-panel')).to_contain_text('內容與最近匯出相同')
    page.reload()
    expect(page.locator('.storage-panel')).to_contain_text('內容與最近匯出相同')
    # Saving fails honestly; existing data isn't replaced.
    page.evaluate('''() => {window.realSet=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){if(k==='433.portfolio.v2')throw new DOMException('full','QuotaExceededError');return window.realSet.call(this,k,v);};}''')
    field.fill('24000')
    expect(page.locator('.storage-panel')).to_contain_text('保存失敗')
    assert page.evaluate('JSON.parse(localStorage.getItem("433.portfolio.v2")).portfolio.cash') == 23000
    page.evaluate('() => {Storage.prototype.setItem=window.realSet;}')
    page.get_by_role('button', name='立即重試保存').click()
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    # Simultaneous tab: stop this tab from overwriting the newer data.
    other = ctx.new_page(); other.on('dialog', lambda d:d.accept()); other.goto(url)
    other.get_by_label('現金餘額', exact=True).fill('25000')
    expect(other.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    expect(page.locator('.storage-panel')).to_contain_text('另一個分頁')
    field.fill('99999'); page.wait_for_timeout(750)
    assert page.evaluate('JSON.parse(localStorage.getItem("433.portfolio.v2")).portfolio.cash') == 25000
    other.close(); page.reload()
    # Demo and actual/estimated state persists across page reload and edits.
    page.get_by_role('button', name='載入示範', exact=True).click()
    page.get_by_role('button', name='確認載入', exact=True).click()
    page.get_by_role('button', name='保存選定試算方案').click()
    assert page.get_by_label('現金餘額', exact=True).input_value() == '150000'
    page.get_by_role('button', name='套用估計方案供核對').click()
    expect(page.get_by_role('heading', name='待成交核對', exact=True)).to_be_visible()
    page.reload()
    expect(page.get_by_role('heading', name='待成交核對', exact=True)).to_be_visible()
    page.get_by_label('現金餘額', exact=True).fill('180001')
    expect(page.get_by_role('heading', name='待成交核對', exact=True)).to_be_visible()
    page.get_by_role('button', name='回到套用前').click()
    expect(page.get_by_label('現金餘額', exact=True)).to_have_value('150000')
    page.get_by_role('button', name='套用估計方案供核對').click()
    page.get_by_role('button', name='已核對成交，標記為實際持倉').click()
    expect(page.get_by_role('heading', name='待成交核對', exact=True)).to_have_count(0)
    # Snapshot comparison and scenario UI, and mobile geometry.
    select = page.get_by_label('比較起點', exact=True)
    select.select_option(index=1)
    expect(page.locator('.snapshot-comparison').get_by_text('總資產差額', exact=False)).to_be_visible()
    page.get_by_label('00662 漲跌 %', exact=True).fill('-20')
    page.get_by_label('00675L 漲跌 %', exact=True).fill('-40')
    expect(page.get_by_text('情境後總資產', exact=True)).to_be_visible()
    page.screenshot(path='test-results/v2-desktop.png', full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path='test-results/v2-mobile.png',full_page=True)
    assert page.evaluate('localStorage.getItem("433.portfolio.v1")') == original
    # 50 snapshots stop additions, never silently trim.
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    full = page.evaluate('JSON.parse(localStorage.getItem("433.portfolio.v2"))')
    full['snapshots'] = [{'id':str(i),'name':f'快照{i}','date':'2026-10-07T00:00:00Z','portfolio':full['portfolio']} for i in range(50)]
    page.locator('input[type=file]').set_input_files({'name':'full.json','mimeType':'application/json','buffer':json.dumps(full).encode()})
    page.get_by_role('button', name='確認載入', exact=True).click()
    expect(page.get_by_role('button',name='保存目前快照',exact=True)).to_be_disabled()
    expect(page.get_by_role('button',name='保存選定試算方案',exact=True)).to_be_disabled()
    expect(page.locator('.snapshot-list > div')).to_have_count(50)
    # Temporary mode must work even if storage read AND write throw.
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
    saved_v2 = page.evaluate('localStorage.getItem("433.portfolio.v2")')
    temporary = ctx.new_page()
    temporary.add_init_script('''Storage.prototype.getItem=function(){throw new Error('No storage reads allowed')}; Storage.prototype.setItem=function(){throw new Error('No storage writes allowed')};''')
    temporary.on('pageerror', lambda e:errors.append(str(e)))
    temporary.goto(url+'?mode=temporary')
    expect(temporary.get_by_label('現金餘額',exact=True)).to_have_value('0')
    temporary.get_by_label('現金餘額',exact=True).fill('34567')
    temporary.get_by_role('button',name='保存目前快照',exact=True).click()
    temporary.wait_for_timeout(750)
    expect(temporary.locator('.storage-panel')).to_contain_text('暫用模式')
    temporary.reload()
    expect(temporary.get_by_label('現金餘額',exact=True)).to_have_value('0')
    assert page.evaluate('localStorage.getItem("433.portfolio.v2")') == saved_v2
    # Damaged storage stays available for recovery and is never silently replaced.
    damaged_context = browser.new_context(accept_downloads=True)
    damaged = damaged_context.new_page()
    damaged.goto(base)
    damaged.evaluate("localStorage.setItem('433.portfolio.v2', '{broken')")
    damaged.goto(url)
    expect(damaged.locator('.storage-panel')).to_contain_text('已停止保存')
    damaged.get_by_label('現金餘額', exact=True).fill('123')
    damaged.wait_for_timeout(750)
    assert damaged.evaluate("localStorage.getItem('433.portfolio.v2')") == '{broken'
    with damaged.expect_download() as recovery:
        damaged.get_by_role('button', name='下載原始資料', exact=True).click()
    assert Path(recovery.value.path()).read_text() == '{broken'
    assert not errors, errors
    browser.close()
print('PASS: V2 import, write coalescing, reload flush, export status, quota failure/retry, tab conflict, estimate workflow, comparisons, snapshot cap, temporary no-read/no-write, V1 isolation and mobile layout')

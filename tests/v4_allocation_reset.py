"""Valuation and destructive-action safeguards using synthetic data only."""
import copy
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4'); OUT.mkdir(parents=True, exist_ok=True)
report = []
def fixture():
    assets = [{'id': str(i), 'ticker': code, 'name': name, 'kind': kind, 'shares': shares, 'price': price, 'target': target, 'limit': 'free', 'lot': 1, 'feeRate': .1425, 'minFee': 0, 'sellTaxRate': tax, 'feeMode': 'manual'} for i, (code, name, kind, shares, price, target, tax) in enumerate([
        ('2330', '合成核心', 'core', 40, 1000, 40, .3), ('00675L', '合成正二', 'leverage', 150, 200, 30, .1), ('00662', '合成其他', 'other', 100, 100, 10, .1)])]
    p = {'version': 1, 'cash': 25000, 'settlement': -5000, 'flow': 30000, 'cashFloor': 10, 'cashTarget': 20, 'tolerance': 2, 'assets': assets}
    return {'version': 3, 'state': 'actual', 'portfolio': p, 'snapshots': [{'id': 'saved', 'date': '2026-10-07T00:00:00Z', 'name': '保留快照', 'kind': 'actual', 'portfolio': copy.deepcopy(p)}], 'evidence': []}
def stored(page): return page.evaluate('(k)=>JSON.parse(localStorage.getItem(k))', KEY)
def saved_cash(page, cash): page.wait_for_function('({k,c})=>JSON.parse(localStorage.getItem(k))?.portfolio.cash===c', arg={'k': KEY, 'c': cash})
def upload(page, data):
    page.locator('input[type=file]').set_input_files({'name': 'synthetic.json', 'mimeType': 'application/json', 'buffer': json.dumps(data).encode()})
    page.get_by_role('button', name='確認載入', exact=True).click()
    expect(page.get_by_role('button', name='確認載入', exact=True)).to_have_count(0)
def dialog(page):
    page.get_by_role('button', name='清空目前輸入', exact=True).click()
    return page.get_by_role('dialog')
def confirm_reset(page):
    box = dialog(page)
    box.get_by_label('輸入「清空」以確認', exact=True).fill('清空')
    box.get_by_role('button', name='確認清空目前輸入', exact=True).click()
    expect(box).not_to_be_visible()
def check(name, condition=True):
    assert condition, name
    report.append(name); print('PASS: ' + name, flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    ctx = browser.new_context(accept_downloads=True); page = ctx.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(BASE + 'versions/v4/', wait_until='networkidle'); upload(page, fixture()); saved_cash(page, 25000)
    chart = page.locator('.allocation')
    expect(chart.get_by_role('img')).to_have_attribute('aria-label', '資產佔比：核心持股 40%、台股正二 30%、其他證券 10%、現金（含 T+2） 20%')
    expect(chart.locator('.allocation-total')).to_have_text('$100,000')
    chart.locator('[data-group=cash] summary').click()
    expect(chart.locator('[data-group=cash]')).to_contain_text('$-5,000')
    check('Four-category valuation uses signed T+2, excludes flow and does not double leveraged ETF value')
    page.locator('.asset-card').first.get_by_label('分類', exact=False).select_option('other')
    expect(chart.locator('[data-group=core] .allocation-percent')).to_have_text('0%')
    expect(chart.locator('[data-group=other] .allocation-percent')).to_have_text('50%')
    check('Changing a holding category immediately updates the allocation')
    page.get_by_label('現金餘額', exact=True).fill('0')
    page.get_by_label('交割款（T+2，正收負付）', exact=True).fill('-30000')
    expect(chart.get_by_role('img')).to_have_count(0)
    expect(chart.locator('[data-group=cash] .allocation-percent')).to_have_text('-60%')
    check('Negative net cash retains signed ratios and suppresses the donut')
    page.get_by_label('現金餘額', exact=True).fill('')
    expect(chart.locator('.allocation-total')).to_have_text('$—')
    check('Incomplete valuation does not show misleading percentages')
    upload(page, fixture()); saved_cash(page, 25000)
    for width, height in [(320,568), (390,664), (768,1024), (1440,900)]:
        page.set_viewport_size({'width': width, 'height': height})
        chart.scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(OUT / f'allocation-{width}.png'))
        box = dialog(page)
        expect(box.get_by_role('heading')).to_be_focused()
        expect(box.get_by_role('heading')).to_be_in_viewport(ratio=1)
        expect(box.get_by_role('button', name='確認清空目前輸入', exact=True)).to_be_disabled()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        box.get_by_label('輸入「清空」以確認', exact=True).fill('清')
        expect(box.get_by_role('button', name='確認清空目前輸入', exact=True)).to_be_disabled()
        page.keyboard.press('Escape')
        expect(box).not_to_be_visible()
        expect(page.get_by_label('現金餘額', exact=True)).to_have_value('25000')
    check('Four viewport sizes: no horizontal overflow, safe initial focus, exact confirmation, Escape preserves values')
    box = dialog(page)
    with page.expect_download() as download:
        box.get_by_role('button', name='先匯出 JSON 備份', exact=True).click()
    backup = json.loads(Path(download.value.path()).read_bytes())
    assert backup['portfolio'] == fixture()['portfolio']
    box.get_by_label('輸入「清空」以確認', exact=True).fill('清空')
    box.get_by_role('button', name='取消', exact=True).click()
    box = dialog(page)
    expect(box.get_by_label('輸入「清空」以確認', exact=True)).to_have_value('')
    box.get_by_role('button', name='取消', exact=True).click()
    check('Pre-clear backup contains original financial data; cancel and reopen resets confirmation')
    page.evaluate("localStorage.setItem('433.portfolio.v1','preserve-v1')")
    page.get_by_role('button', name='載入示範', exact=True).click()
    confirm_reset(page); saved_cash(page, 0)
    b = stored(page)
    assert b['portfolio'] == {'version': 1, 'assets': [], 'cash': 0, 'settlement': 0, 'flow': 0, 'cashFloor': 10, 'cashTarget': None, 'tolerance': 2}
    assert b['snapshots'] == fixture()['snapshots']
    assert b['state'] == 'actual' and 'beforeEstimate' not in b
    expect(page.get_by_role('button', name='確認載入', exact=True)).to_have_count(0)
    assert page.evaluate("localStorage.getItem('433.portfolio.v1')") == 'preserve-v1'
    page.reload(); expect(page.locator('.asset-card')).to_have_count(0)
    expect(chart.get_by_role('img')).to_have_count(0)
    check('Clear persists blank defaults, removes pending demo, keeps snapshots and V1, survives reload')
    upload(page, backup); saved_cash(page, 25000)
    check('Pre-clear downloaded backup restores original portfolio')
    estimate = fixture(); estimate['state'] = 'estimate'; estimate['beforeEstimate'] = copy.deepcopy(estimate['portfolio'])
    upload(page, estimate)
    expect(chart).to_contain_text('待成交核對的估計持倉')
    confirm_reset(page); saved_cash(page, 0)
    assert stored(page)['state'] == 'actual' and 'beforeEstimate' not in stored(page)
    check('Clearing an estimated plan clears pending reconciliation state')
    upload(page, fixture()); saved_cash(page, 25000)
    # Delay the read to ensure clearing invalidates a still-running import.
    page.evaluate('''() => { const original=File.prototype.text; File.prototype.text=function(){return new Promise(resolve=>{window.finishImport=()=>original.call(this).then(resolve)})}; }''')
    page.locator('input[type=file]').set_input_files({'name': 'slow.json', 'mimeType': 'application/json', 'buffer': json.dumps(fixture()).encode()})
    confirm_reset(page); saved_cash(page, 0)
    page.evaluate('window.finishImport()')
    expect(page.get_by_role('button', name='確認載入', exact=True)).to_have_count(0)
    expect(page.locator('.asset-card')).to_have_count(0)
    check('Late import completion cannot resurrect cleared inputs or preview')
    page.reload(); upload(page, fixture()); saved_cash(page, 25000)
    original = page.evaluate('(k)=>localStorage.getItem(k)', KEY)
    temporary = ctx.new_page(); temporary.goto(BASE + 'versions/v4/?mode=temporary', wait_until='networkidle')
    upload(temporary, fixture()); confirm_reset(temporary)
    assert page.evaluate('(k)=>localStorage.getItem(k)', KEY) == original
    check('Temporary clear never changes saved normal-mode data')
    temporary.close()
    other = ctx.new_page(); other.goto(BASE + 'versions/v4/', wait_until='networkidle')
    box = dialog(page)
    other.get_by_label('現金餘額', exact=True).fill('55555'); saved_cash(other, 55555)
    expect(box).to_contain_text('目前保存已停止')
    box.get_by_label('輸入「清空」以確認', exact=True).fill('清空')
    expect(box.get_by_role('button', name='確認清空目前輸入', exact=True)).to_be_disabled()
    check('A concurrent tab update disables destructive confirmation and preserves the newer saved data', stored(page)['portfolio']['cash'] == 55555)
    check('No JavaScript runtime errors', not errors)
    ctx.close(); browser.close()
(OUT / 'allocation-reset.json').write_text(json.dumps({'checks': report}, ensure_ascii=False, indent=2))

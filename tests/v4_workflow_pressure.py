"""Adversarial task, mapped-import, sandbox and history workflows; synthetic data only."""
import copy
import json
import os
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4'); OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'measurements': {}, 'errors': []}

def fixture():
    p = {'version': 1, 'cash': 25000, 'settlement': -5000, 'flow': 30000, 'cashFloor': 10, 'cashTarget': 20, 'tolerance': 2, 'assets': [
        {'id': str(i), 'ticker': code, 'name': '合成測試 '+code, 'kind': kind, 'shares': shares, 'price': price, 'target': target, 'limit': 'free', 'lot': 1, 'feeRate': .1425, 'minFee': 0, 'sellTaxRate': tax, 'feeMode': 'manual'} for i,(code,kind,shares,price,target,tax) in enumerate([('00662','core',400,100,40,.1),('00675L','leverage',150,200,30,.1),('2330','other',10,1000,10,.3)])]}
    return {'version':3,'portfolio':p,'state':'actual','snapshots':[{'id':'actual','name':'實際起點','kind':'actual','date':'2026-10-01T00:00:00Z','portfolio':copy.deepcopy(p)}], 'evidence':[]}

def upload(page, content, name='synthetic.json'):
    page.locator('input[type=file]').set_input_files({'name':name,'mimeType':'text/plain','buffer':content if isinstance(content,bytes) else json.dumps(content).encode()})
def load(page,data):
    upload(page,data);page.get_by_role('button',name='確認載入',exact=True).click()
    expect(page.get_by_role('button',name='確認載入',exact=True)).to_have_count(0)
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器',timeout=15000)
def stored(page): return page.evaluate('(k)=>JSON.parse(localStorage.getItem(k))',KEY)
def check(name, passed=True):
    report['checks'].append({'name':name,'passed':bool(passed)})
    print(('PASS: ' if passed else 'FAIL: ')+name,flush=True)
    assert passed,name
def mapper(page, text, unit='share'):
    upload(page,text.encode(),'broker.csv')
    heading=page.get_by_role('heading',name='外部 CSV 欄位對應',exact=True)
    expect(heading).to_be_focused();expect(heading).to_be_in_viewport(ratio=1)
    page.get_by_label('CSV 數量單位',exact=True).select_option(unit)
    page.locator('.csv-mapper input[type=checkbox]').check()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
    ctx=browser.new_context(accept_downloads=True);page=ctx.new_page();page.on('dialog',lambda d:d.accept());page.on('pageerror',lambda e:report['errors'].append(str(e)))
    try:
        page.goto(BASE+'versions/v4/',wait_until='networkidle');load(page,fixture())
        comparison=page.locator('.allocation-comparison').first
        expect(comparison.locator('[data-comparison=core]')).to_contain_text('40%')
        for label,mode,flow in [('本次提領資金','完整再平衡','-30000'),('本次投入資金','僅用新增資金','30000'),('檢查再平衡','容許區間調整','0')]:
            page.get_by_role('button',name=label,exact=True).click()
            expect(page.get_by_label('本次投入／提領（正投負提）',exact=True)).to_have_value(flow)
            expect(page.locator('.plan-card.selected')).to_contain_text(mode)
        check('Task entry selects signs and modes without changing holdings')
        load(page,fixture())
        original=stored(page)['portfolio']
        page.get_by_role('button',name='從目前持倉建立草稿',exact=True).click()
        expect(page.get_by_role('heading',name='編輯獨立草稿',exact=True)).to_be_focused()
        page.get_by_label('草稿投入／提領',exact=True).fill('70000')
        page.get_by_label('草稿名稱',exact=True).fill('七萬投入草稿')
        page.get_by_label('草稿模式',exact=True).select_option('contribute')
        check('Editing a draft leaves current holdings and local portfolio unchanged',stored(page)['portfolio']==original)
        page.get_by_role('button',name='保存草稿方案',exact=True).click()
        page.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).snapshots.length===2',arg=KEY)
        data=stored(page);assert data['portfolio']==original and data['snapshots'][0]['sourcePortfolio']['flow']==70000
        expect(page.locator('.snapshot-trend summary')).to_have_text('實際快照趨勢（1 份）')
        page.reload();expect(page.locator('.draft-comparison')).to_contain_text('七萬投入草稿')
        page.get_by_role('button',name='以此方案另開草稿',exact=True).click()
        expect(page.get_by_label('草稿投入／提領',exact=True)).to_have_value('70000')
        page.get_by_role('button',name='關閉草稿',exact=True).click()
        check('Draft survives reload and source reopening; hypothetical plans stay out of actual trend')
        with page.expect_download() as download:page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
        exported=json.loads(Path(download.value.path()).read_bytes());load(page,exported)
        check('Full JSON round-trip retains draft and its source with actual portfolio unchanged',stored(page)['portfolio']==original and len(stored(page)['snapshots'])==2)

        mapper(page,'證券代號,數量,現價,幣別\n00662,1.001,99,TWD\n2330,0.001,1000,TWD',unit='lot')
        page.get_by_role('button',name='預覽持倉差異',exact=True).click()
        expect(page.locator('.import-diff')).to_contain_text('1,001');expect(page.locator('.import-diff')).to_contain_text('移除')
        page.get_by_label('現金餘額',exact=True).fill('55555')
        page.get_by_role('button',name='確認載入',exact=True).click()
        page.wait_for_function('(k)=>{const b=JSON.parse(localStorage.getItem(k));return b.portfolio.cash===55555 && b.portfolio.assets.length===2}',arg=KEY)
        p=stored(page)['portfolio'];assert p['cashTarget'] is None and [a['shares'] for a in p['assets']]==[1001,1] and p['assets'][0]['sellTaxRate']==.1 and len(stored(page)['snapshots'])==2
        check('Mapped lots convert exactly; diff includes removed positions; latest cash, fees and history survive')

        for text,reason in [('代號,數量,現價\n00662,1,100\n００６６２,2,100','重複'),('代號,數量,現價,幣別\n2330,1,100,USD','新臺幣'),('代號,數量,現價\n2330,=1+2,100','數字')]:
            before=stored(page);mapper(page,text)
            expect(page.locator('.csv-mapper')).to_contain_text(reason)
            expect(page.get_by_role('button',name='預覽持倉差異',exact=True)).to_be_disabled()
            page.get_by_role('button',name='取消欄位對應',exact=True).click();assert stored(page)==before
        check('Duplicate symbols, foreign currency and spreadsheet formulas cannot be confirmed or mutate data')
        upload(page,b'ticker,shares,price,recordType\n2330,1,100,rebalance_plan_not_executed','bad.csv')
        expect(page.locator('.status')).to_contain_text('匯入失敗')
        expect(page.locator('.csv-mapper')).to_have_count(0)
        check('Malformed native exchange cannot downgrade into external mapping')

        upload(page,b'ticker,shares,price,name\n2330,1,100,\xff','encoding.csv')
        expect(page.locator('.status')).to_contain_text('UTF-8')
        expect(page.locator('.csv-mapper')).to_have_count(0)
        check('Undecodable CSV is rejected with an encoding explanation')

        mapper(page,'代號,數量,現價,名稱\n2330,1,100,<img src=x onerror=alert(1)>')
        page.get_by_role('button',name='預覽持倉差異',exact=True).click();page.get_by_role('button',name='確認載入',exact=True).click()
        expect(page.locator('img[src=x]')).to_have_count(0)
        check('Imported markup is literal data, never executable HTML')
        load(page,fixture());page.get_by_role('button',name='從目前持倉建立草稿',exact=True).click()
        mapper(page,'代號,數量,現價\n2330,1,100')
        page.get_by_role('button',name='清空目前輸入',exact=True).click()
        page.get_by_label('輸入「清空」以確認',exact=True).fill('清空');page.get_by_role('button',name='確認清空目前輸入',exact=True).click()
        expect(page.locator('.csv-mapper')).to_have_count(0);expect(page.locator('.draft-editor')).to_have_count(0)
        check('Safe reset invalidates both pending mapping and unsaved draft')

        load(page,fixture())
        for width,height in [(320,568),(390,664),(768,1024),(1440,900)]:
            page.set_viewport_size({'width':width,'height':height})
            comparison.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.screenshot(path=str(OUT/f'workflow-comparison-{width}.png'))
            mapper(page,'代號,數量,現價\n2330,1,100')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.screenshot(path=str(OUT/f'workflow-mapper-{width}.png'))
            page.get_by_role('button',name='取消欄位對應',exact=True).click()
            page.get_by_role('button',name='從目前持倉建立草稿',exact=True).click()
            expect(page.get_by_role('heading',name='編輯獨立草稿',exact=True)).to_be_in_viewport(ratio=1)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.get_by_role('button',name='關閉草稿',exact=True).click()
        check('Four screen sizes preserve comparison, mapper and draft layout and automatic focus')

        large=fixture();large['portfolio']['cashTarget']=None
        large['portfolio']['assets']=[dict(large['portfolio']['assets'][0],id=str(i),ticker=str(1000+i),target=None) for i in range(100)]
        large['snapshots']=[{'id':str(i),'name':f'實際快照{i}','date':f'2026-10-{i%28+1:02}T00:00:00Z','kind':'actual','portfolio':copy.deepcopy(large['portfolio'])} for i in range(50)]
        started=time.monotonic();load(page,large)
        report['measurements']['100_holdings_50_actual_snapshots_load_seconds']=round(time.monotonic()-started,3)
        expect(page.locator('.snapshot-trend tbody tr')).to_have_count(50)
        expect(page.get_by_role('button',name='從目前持倉建立草稿',exact=True)).to_be_disabled()
        for i in range(60):page.get_by_label('現金餘額',exact=True).fill(str(100000+i))
        page.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).portfolio.cash===100059',arg=KEY)
        page.reload();expect(page.locator('.asset-card')).to_have_count(100);expect(page.locator('.snapshot-trend tbody tr')).to_have_count(50)
        check('100 holdings and 50 actual snapshots survive 60 rapid edits, reload and full-capacity safeguards')

        load(page,fixture());ctx.set_offline(True)
        mapper(page,'代號,數量,現價\n2330,10,100')
        page.get_by_role('button',name='預覽持倉差異',exact=True).click();page.get_by_role('button',name='確認載入',exact=True).click()
        page.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).portfolio.assets.length===1',arg=KEY)
        ctx.set_offline(False);check('Already-loaded page maps and saves CSV without network access')

        estimated=fixture();estimated['state']='estimate';estimated['beforeEstimate']=copy.deepcopy(estimated['portfolio'])
        load(page,estimated)
        mapper(page,'代號,數量,現價\n2330,10,100')
        page.get_by_role('button',name='預覽持倉差異',exact=True).click();page.get_by_role('button',name='確認載入',exact=True).click()
        page.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).portfolio.assets.length===1',arg=KEY)
        check('Mapped CSV cannot clear a pending reconciliation state',stored(page)['state']=='estimate' and stored(page)['beforeEstimate']==estimated['beforeEstimate'])

        original=page.evaluate('(k)=>localStorage.getItem(k)',KEY)
        temp=ctx.new_page();temp.on('dialog',lambda d:d.accept());temp.goto(BASE+'versions/v4/?mode=temporary',wait_until='networkidle')
        mapper(temp,'代號,數量,現價\n2330,1,100');temp.get_by_role('button',name='預覽持倉差異',exact=True).click();temp.get_by_role('button',name='確認載入',exact=True).click()
        assert page.evaluate('(k)=>localStorage.getItem(k)',KEY)==original;temp.close();check('Temporary mapped import does not touch normal browser storage')

        mapper(page,'代號,數量,現價\n2330,2,100');page.get_by_role('button',name='預覽持倉差異',exact=True).click()
        other=ctx.new_page();other.goto(BASE+'versions/v4/',wait_until='networkidle');other.get_by_label('現金餘額',exact=True).fill('87654')
        other.wait_for_function('(k)=>JSON.parse(localStorage.getItem(k)).portfolio.cash===87654',arg=KEY)
        expect(page.get_by_role('button',name='確認載入',exact=True)).to_be_disabled()
        check('Concurrent-tab change blocks pending confirmation instead of overwriting newer data')
        check('No JavaScript runtime errors',not report['errors'])
    finally:
        (OUT/'workflow-pressure.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        ctx.close();browser.close()

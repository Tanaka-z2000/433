"""Independent black-box audit; only generated fixtures enter disposable browsers.

The expected cash and fee calculations below do not import the app's engine.
Actual observations are saved even when a check fails.
"""
import copy
import csv
import io
import json
import os
from pathlib import Path
import time
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v2'
OUT = Path('test-results'); OUT.mkdir(exist_ok=True)
report = {'url': BASE, 'checks': [], 'measurements': {}, 'browser_errors': [], 'requests_after_load': []}

def check(name, condition, details=None):
    report['checks'].append({'name': name, 'passed': bool(condition), 'details': details})
    print(('PASS: ' if condition else 'FAIL: ') + name + (f' — {details}' if details is not None else ''), flush=True)

def asset(ticker, shares, price, target, kind='other', limit='free', lot=1):
    return {'id':ticker,'ticker':ticker,'kind':kind,'shares':shares,'price':price,'target':target,'limit':limit,'lot':lot,'feeRate':0.1425,'minFee':0,'sellTaxRate':0.1}

def portfolio():
    return {'version':1,'cash':100000,'settlement':-20000,'flow':10000,'cashFloor':10,'cashTarget':20,'tolerance':2,
            'assets':[asset('00662',1500,100,50,'core'),asset('00675L',100,100,30,'leverage')]}

def backup(p, snapshots=None):
    return {'version':2,'portfolio':p,'snapshots':snapshots or [],'evidence':[],'state':'actual'}

def amount(text):
    return Decimal(text.replace('$','').replace(',','').strip())

def charge(a, quantity):
    if not quantity: return Decimal(0)
    gross = abs(Decimal(quantity))*Decimal(str(a['price']))
    value = max(Decimal(str(a['minFee'])), gross*Decimal(str(a['feeRate']))/100)
    if quantity < 0: value += gross*Decimal(str(a['sellTaxRate']))/100
    return value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(accept_downloads=True)
    page = context.new_page(); page.on('dialog', lambda d:d.accept())
    page.on('pageerror', lambda e:report['browser_errors'].append(str(e)))
    start = time.perf_counter()
    try:
        response = context.request.get(BASE+'release.json', headers={'Cache-Control':'no-cache'})
        assert response.ok, f'release.json HTTP {response.status}'
        release = response.json(); report['release'] = release
        page.goto(BASE+'versions/v2/',wait_until='networkidle')
        check('V2 HTML matches release identity', page.locator('meta[name=build-id]').get_attribute('content') == release['buildId'])
        page.on('request', lambda r:report['requests_after_load'].append({'method':r.method,'url':r.url,'type':r.resource_type}))
        def load(data):
            page.locator('input[type=file]').set_input_files({'name':'audit.json','mimeType':'application/json','buffer':json.dumps(data).encode()})
            page.get_by_role('button',name='確認載入',exact=True).click()
            expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
        p=portfolio(); load(backup(p))
        initial_total=Decimal('240000'); funding_total=Decimal('250000')
        check('Signed T+2 and contribution totals', [amount(x) for x in page.locator('.summary strong').all_text_contents()] == [initial_total,Decimal('80000'),funding_total])
        for mode, title in [('full','完整再平衡'),('contribute','僅用新增資金'),('band','容許區間調整')]:
            page.locator('.plan-card').filter(has=page.get_by_text(title,exact=True)).click()
            with page.expect_download() as downloaded:
                page.get_by_role('button',name='匯出方案 CSV',exact=True).click()
            rows=list(csv.reader(io.StringIO(Path(downloaded.value.path()).read_text(encoding='utf-8-sig'))))[1:]
            gross=Decimal(0);cost=Decimal(0);valid=True;positive_spend=Decimal(0);line_details=[]
            for row,a in zip(rows,p['assets']):
                qty=int(row[1]);line_gross=Decimal(row[2]);line_fee=Decimal(row[3]);after=Decimal(row[4])
                line_details.append({'ticker':a['ticker'],'quantity':qty,'actual_fee':str(line_fee),'expected_fee':str(charge(a,qty))})
                valid &= line_gross == Decimal(qty)*Decimal(a['price']) and line_fee == charge(a,qty)
                valid &= after == Decimal(a['shares']+qty)*Decimal(a['price']) and a['shares']+qty >= 0 and qty%a['lot']==0
                gross+=line_gross;cost+=line_fee
                if qty>0: positive_spend+=line_gross+line_fee
                if mode=='contribute':valid &= qty>=0
            expected_cash=Decimal('90000')-gross-cost
            displayed=[amount(x) for x in page.locator('.result-metrics strong').all_text_contents()]
            valid &= displayed == [funding_total-cost,expected_cash,cost]
            if mode=='contribute':valid &= positive_spend<=10000
            check(f'{title}: independent fees, shares and conservation',valid,{'displayed':[str(x) for x in displayed], 'trades':line_details})
        page.locator('.plan-card').filter(has=page.get_by_text('完整再平衡',exact=True)).click()
        page.get_by_label('00662 漲跌 %',exact=True).fill('-100');page.get_by_label('00675L 漲跌 %',exact=True).fill('-100')
        cells=page.locator('.scenario-table tbody tr').nth(2).locator('td').all_text_contents()
        check('100% equity loss leaves only signed cash',amount(cells[1])==90000 and amount(cells[2])==amount(page.locator('.result-metrics strong').nth(1).inner_text()))
        # Real JSON round-trip, including a saved plan, not merely download creation.
        page.get_by_role('button',name='保存選定試算方案',exact=True).click()
        expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
        with page.expect_download() as downloaded:
            page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
        exported=json.loads(Path(downloaded.value.path()).read_text())
        page.get_by_label('現金餘額',exact=True).fill('54321')
        load(exported)
        stored=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
        check('JSON restores actual content and saved plan',stored['portfolio']==exported['portfolio'] and stored['snapshots']==exported['snapshots'])
        # Restore a plan from the list, then reload and ensure its status remains estimated.
        page.locator('.snapshot-list > div').first.get_by_role('button',name='還原',exact=True).click()
        page.get_by_role('button',name='確認載入',exact=True).click();page.reload(wait_until='networkidle')
        check('Restored plan cannot silently become actual holdings',page.get_by_role('heading',name='待成交核對',exact=True).count()==1)
        page.get_by_role('button',name='回到套用前',exact=True).click()
        # Status accuracy when invalid input is restored to the exact saved value.
        expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
        cash=page.get_by_label('現金餘額',exact=True);old=cash.input_value();cash.fill('')
        expect(page.locator('.storage-panel')).to_contain_text('本次輸入未完整')
        cash.fill(old);page.wait_for_timeout(800)
        status=page.locator('.storage-panel > p').first.inner_text()
        check('Reverting invalid input shows saved state', '尚未保存' not in status, status)
        page.locator('.storage-panel').screenshot(path=str(OUT/'save-status-reverted.png'))
        # Stress the supported maximum: 100 holdings and 50 snapshots.
        large=portfolio();large.update(cashTarget=None,flow=0)
        large['assets']=[asset(f'{i:05}',100+i,10+i,None) for i in range(100)]
        snapshots=[{'id':str(i),'name':f'負擔測試 {i}','date':'2026-10-07T00:00:00Z','kind':'actual','portfolio':copy.deepcopy(large)} for i in range(50)]
        load(backup(large,snapshots))
        raw=page.evaluate('(key)=>localStorage.getItem(key)',KEY)
        report['measurements']['max_fixture_utf16_bytes']=(len(raw)+len(KEY))*2
        report['measurements']['max_fixture_json_utf8_bytes']=len(raw.encode())
        page.evaluate('''() => {window.writes=[]; const original=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){const start=performance.now();const result=original.call(this,k,v);if(k==='433.portfolio.v2')window.writes.push(performance.now()-start);return result;};}''')
        start_edit=time.perf_counter();page.get_by_label('現金餘額',exact=True).fill('100001')
        expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器',timeout=15000)
        report['measurements']['max_fixture_edit_to_saved_ms']=round((time.perf_counter()-start_edit)*1000,1)
        report['measurements']['storage_write_ms']=page.evaluate('window.writes')
        page.wait_for_timeout(1200)
        check('Maximum supported dataset saves once then stays idle',page.evaluate('window.writes.length')==1)
        with page.expect_download() as downloaded:
            page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
        large_export=json.loads(Path(downloaded.value.path()).read_text());load(large_export)
        check('Maximum supported dataset round-trips all records',page.locator('.asset-card').count()==100 and page.locator('.snapshot-list > div').count()==50)
        # Restore manageable data for device layout screenshots.
        load(backup(p));page.set_viewport_size({'width':1280,'height':900})
        page.screenshot(path=str(OUT/'live-desktop.png'))
        for width in [320,390,768]:
            page.set_viewport_size({'width':width,'height':844})
            check(f'No document horizontal overflow at {width}px',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        page.screenshot(path=str(OUT/'live-tablet.png'))
        page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(OUT/'live-mobile.png'))
        data_requests=[r for r in report['requests_after_load'] if r['type'] in ['fetch','xhr','websocket'] or r['method'] not in ['GET','HEAD']]
        check('No portfolio upload requests during tested workflows',len(data_requests)==0,data_requests)
        original=context.new_page(); original.on('dialog',lambda d:d.accept());original.goto(BASE)
        original.evaluate('(data)=>localStorage.setItem("433.portfolio.v1",JSON.stringify(data))',{**backup(p),'version':1})
        original.goto(BASE+'versions/v1/',wait_until='networkidle')
        with original.expect_download() as downloaded:
            original.get_by_role('button',name='匯出方案 CSV',exact=True).click()
        v1_rows=list(csv.reader(io.StringIO(Path(downloaded.value.path()).read_text(encoding='utf-8-sig'))))[1:]
        check('V1 independent half-cent rounding',Decimal(v1_rows[0][3])==charge(p['assets'][0],int(v1_rows[0][1])),{'actual_fee':v1_rows[0][3],'expected_fee':str(charge(p['assets'][0],int(v1_rows[0][1])))})
        ending=context.request.get(BASE+'release.json',headers={'Cache-Control':'no-cache'}).json()
        check('Published release remained unchanged during audit',ending['commit']==release['commit'])
        check('No JavaScript runtime errors',not report['browser_errors'],report['browser_errors'])
    except Exception as error:
        check('Audit completed without unexpected interruption',False,str(error))
        page.screenshot(path=str(OUT/'live-failure.png'),full_page=True)
    finally:
        report['elapsed_seconds']=round(time.perf_counter()-start,2)
        (OUT/'live-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report['measurements'],ensure_ascii=False),flush=True)
        browser.close()
if any(not x['passed'] for x in report['checks']):
    raise SystemExit(1)

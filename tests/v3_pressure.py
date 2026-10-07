"""Adversarial imports, repeated edits, maximum records and real storage quota.

All data is synthetic and lives in a disposable browser context.
"""
import copy
import json
import os
from pathlib import Path
import time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v3'
OUT = Path('test-results/v3'); OUT.mkdir(parents=True, exist_ok=True)
report = {'checks': [], 'measurements': {}, 'errors': []}

def check(name, condition):
    report['checks'].append({'name': name, 'passed': bool(condition)})
    print(('PASS: ' if condition else 'FAIL: ') + name, flush=True)
    assert condition, name

with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page(); page.on('dialog', lambda d: d.accept())
    page.on('pageerror', lambda e: report['errors'].append(str(e)))
    try:
        page.goto(BASE)
        page.evaluate('''() => {localStorage.setItem('433.portfolio.v1','v1-preserved');localStorage.setItem('433.portfolio.v2','v2-preserved')}''')
        page.goto(BASE+'versions/v3/')
        panel = page.locator('.storage-panel')
        field = page.get_by_label('現金餘額', exact=True)
        field.fill('100000')
        expect(panel).to_contain_text('已保存於此瀏覽器')
        page.evaluate('''() => {window.writes=[]; const real=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){const start=performance.now();const result=real.call(this,k,v);if(k==='433.portfolio.v3')window.writes.push(performance.now()-start);return result;};}''')
        for i in range(100): field.fill(str(100001+i))
        expect(panel).to_contain_text('已保存於此瀏覽器')
        check('100 rapid edits coalesce and persist the last value', page.evaluate('window.writes.length') == 1 and page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).portfolio.cash', KEY) == 100100)
        for i in range(20):
            field.fill(''); expect(panel).to_contain_text('本次輸入未完整')
            field.fill('100100'); expect(panel).to_contain_text('已保存於此瀏覽器')
        check('20 invalid/restore cycles recover status without writes', page.evaluate('window.writes.length') == 1)
        page.evaluate('''() => window.dispatchEvent(new StorageEvent('storage',{key:'433.portfolio.v3',newValue:'different',storageArea:sessionStorage}))''')
        field.fill('100101'); expect(panel).to_contain_text('已保存於此瀏覽器')
        check('Session storage events do not block local persistence', '另一個分頁' not in panel.inner_text())

        p = {'version':1,'assets':[],'cash':100000,'settlement':-10000,'flow':0,'cashFloor':10,'cashTarget':None,'tolerance':2}
        for i in range(100):
            p['assets'].append({'id':str(i),'ticker':f'{i:05}','kind':'other','shares':100+i,'price':10+i,'target':None,'limit':'free','lot':1,'feeRate':.1425,'minFee':0,'sellTaxRate':.1})
        data = {'version':2,'state':'estimate','beforeEstimate':p,'portfolio':p,'evidence':[], 'snapshots':[
            {'id':str(i),'name':f'含原始持倉的試算 {i}','date':'2026-10-07T00:00:00Z','kind':'plan','mode':'full','portfolio':p,'sourcePortfolio':p} for i in range(50)]}
        def upload(content, name='stress.json'):
            page.locator('input[type=file]').set_input_files({'name':name,'mimeType':'text/plain','buffer':content})
        upload(json.dumps(data).encode())
        expect(page.get_by_role('button',name='確認載入',exact=True)).to_be_visible()
        upload(b'{broken','broken.json')
        expect(page.get_by_text('匯入失敗：',exact=False)).to_be_visible()
        check('Invalid replacement import clears the previous preview',page.get_by_role('button',name='確認載入',exact=True).count()==0)
        page.evaluate('''() => {window.fileText=File.prototype.text;File.prototype.text=async function(){if(this.name==='slow.json')await new Promise(r=>setTimeout(r,1500));return window.fileText.call(this);};}''')
        upload(json.dumps(data).encode(),'slow.json');upload(b'null','latest.json')
        expect(page.get_by_text('匯入失敗：',exact=False)).to_be_visible()
        page.wait_for_timeout(1800)
        check('Out-of-order file reads cannot restore an outdated preview',page.get_by_role('button',name='確認載入',exact=True).count()==0)
        page.evaluate('() => {File.prototype.text=window.fileText;}')
        upload(json.dumps(data).encode()); page.get_by_role('button',name='確認載入',exact=True).click()
        expect(panel).to_contain_text('已保存於此瀏覽器',timeout=15000)
        raw=page.evaluate('(key)=>localStorage.getItem(key)',KEY)
        report['measurements']['maximum_with_sources_utf16_bytes']=(len(raw)+len(KEY))*2
        start=time.perf_counter()
        page.evaluate('window.writes=[]')
        for i in range(20): field.fill(str(110000+i))
        expect(panel).to_contain_text('已保存於此瀏覽器',timeout=15000)
        report['measurements']['large_20_edits_and_save_ms']=round((time.perf_counter()-start)*1000,1)
        report['measurements']['large_write_ms']=page.evaluate('window.writes')
        check('Maximum data with 50 source portfolios survives continuous edits',page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).portfolio.cash',KEY)==110019)
        for i in range(3):
            with page.expect_download() as downloaded:
                page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
            exported=json.loads(Path(downloaded.value.path()).read_text())
            upload(json.dumps(exported).encode());page.get_by_role('button',name='確認載入',exact=True).click()
            expect(panel).to_contain_text('已保存於此瀏覽器',timeout=15000)
            restored=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
            check(f'Large JSON round-trip {i+1} preserves all records and estimate state',restored==exported and len(restored['snapshots'])==50 and len(restored['portfolio']['assets'])==100)
        baseline=page.evaluate('(key)=>localStorage.getItem(key)',KEY)
        invalids=[(b'null','null.json'),(b'{broken','broken.json'),(b'{"version":99}','future.json'),(b','*1_000_000,'columns.csv'),(b'a'*1_000_000,'field.csv'),(b'x'*8_000_001,'oversize.json')]
        duplicate=copy.deepcopy(exported);duplicate['portfolio']['assets'][1]['ticker']=duplicate['portfolio']['assets'][0]['ticker'];invalids.append((json.dumps(duplicate).encode(),'duplicate.json'))
        for content,name in invalids:
            upload(content,name)
            expect(page.get_by_text('匯入失敗：',exact=False)).to_be_visible()
            expect(page.get_by_role('button',name='確認載入',exact=True)).to_have_count(0)
            check(f'Rejected {name} without overwriting saved content',page.evaluate('(key)=>localStorage.getItem(key)',KEY)==baseline)

        # Fill real browser quota in this disposable context, leaving no room to grow.
        page.evaluate('''() => {for(const size of [262144,16384,1024,1]){for(let i=0;i<1000;i++){try{localStorage.setItem('quota-'+size+'-'+i,'x'.repeat(size));}catch(e){if(e.name!=='QuotaExceededError')throw e;break;}}}for(let i=0;i<100;i++){try{localStorage.setItem('quota-262144-0',localStorage.getItem('quota-262144-0')+'x');}catch(e){if(e.name!=='QuotaExceededError')throw e;break;}}}''')
        # Grow the existing serialized record while staying below the asset cap.
        field.fill('999999999')
        expect(panel).to_contain_text('保存失敗',timeout=15000)
        check('Real quota failure preserves previous complete data',page.evaluate('(key)=>localStorage.getItem(key)',KEY)==baseline)
        page.evaluate('''() => {Object.keys(localStorage).filter(k=>k.startsWith('quota-')).forEach(k=>localStorage.removeItem(k))}''')
        page.get_by_role('button',name='立即重試保存',exact=True).click()
        expect(panel).to_contain_text('已保存於此瀏覽器',timeout=15000)
        check('Quota recovery saves the latest pending value',page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).portfolio.cash',KEY)==999999999)
        check('V1 and V2 saved data remain unchanged',page.evaluate("localStorage.getItem('433.portfolio.v1')==='v1-preserved' && localStorage.getItem('433.portfolio.v2')==='v2-preserved'"))
        check('No JavaScript errors during pressure tests',not report['errors'])
    except Exception as error:
        report['failure']=str(error)
        page.screenshot(path=str(OUT/'pressure-failure.png'))
        raise
    finally:
        (OUT/'pressure.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report['measurements'],ensure_ascii=False),flush=True)
        browser.close()

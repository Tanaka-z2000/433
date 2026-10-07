"""Adversarial imports, repeated edits, maximum records and real storage quota.

All data is synthetic and lives in a disposable browser context.
"""
import copy
import json
import os
from pathlib import Path
import re
import time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4'); OUT.mkdir(parents=True, exist_ok=True)
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
        page.evaluate('''() => {localStorage.setItem('433.portfolio.v1','v1-preserved');localStorage.setItem('433.portfolio.v2','v2-preserved');localStorage.setItem('433.portfolio.v3','v3-preserved')}''')
        page.goto(BASE+'versions/v4/')
        panel = page.locator('.storage-panel')
        field = page.get_by_label('現金餘額', exact=True)
        field.fill('100000')
        expect(panel).to_contain_text('已保存於此瀏覽器')
        page.evaluate('''() => {window.writes=[]; const real=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){const start=performance.now();const result=real.call(this,k,v);if(k==='433.portfolio.v4')window.writes.push(performance.now()-start);return result;};}''')
        for i in range(100): field.fill(str(100001+i))
        expect(panel).to_contain_text('已保存於此瀏覽器')
        check('100 rapid edits coalesce and persist the last value', page.evaluate('window.writes.length') == 1 and page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).portfolio.cash', KEY) == 100100)
        for i in range(20):
            field.fill(''); expect(panel).to_contain_text('本次輸入未完整')
            field.fill('100100'); expect(panel).to_contain_text('已保存於此瀏覽器')
        check('20 invalid/restore cycles recover status without writes', page.evaluate('window.writes.length') == 1)
        page.evaluate('''() => window.dispatchEvent(new StorageEvent('storage',{key:'433.portfolio.v4',newValue:'different',storageArea:sessionStorage}))''')
        field.fill('100101'); expect(panel).to_contain_text('已保存於此瀏覽器')
        check('Session storage events do not block local persistence', '另一個分頁' not in panel.inner_text())

        p = {'version':1,'assets':[],'cash':100000,'settlement':-10000,'flow':0,'cashFloor':10,'cashTarget':None,'tolerance':2}
        for i in range(100):
            p['assets'].append({'id':str(i),'ticker':f'{i:05}','name':f'合成測試證券完整名稱 {i}','shortName':f'測試 {i}','kind':'other','shares':100+i,'price':10+i,'target':None,'limit':'free','lot':1,'feeRate':.1425,'minFee':0,'sellTaxRate':.1})
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
        migrated=json.loads(raw)
        portfolios=[migrated['portfolio'],migrated['beforeEstimate']]+[s[field] for s in migrated['snapshots'] for field in ['portfolio','sourcePortfolio']]
        check('Legacy migration covers current, estimate and all 50 source portfolios',migrated['version']==3 and all(len(item['assets'])==100 and all(a['feeMode']=='manual' and a['feeRate']==.1425 and a['minFee']==0 and a['sellTaxRate']==.1 for a in item['assets']) for item in portfolios))
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
            exported_bytes=Path(downloaded.value.path()).read_bytes()
            exported=json.loads(exported_bytes)
            upload(exported_bytes);page.get_by_role('button',name='確認載入',exact=True).click()
            expect(panel).to_contain_text('已保存於此瀏覽器',timeout=15000)
            restored=page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
            # The data dictionary travels in the file, not browser persistence.
            expected={k:v for k,v in exported.items() if k!='financeFormat'}
            check(f'Large JSON round-trip {i+1} preserves all records and estimate state',restored==expected and len(restored['snapshots'])==50 and len(restored['portfolio']['assets'])==100)
        baseline=page.evaluate('(key)=>localStorage.getItem(key)',KEY)
        invalids=[(b'null','null.json'),(b'{broken','broken.json'),(b'{"version":99}','future.json'),(b','*1_000_000,'columns.csv'),(b'a'*1_000_000,'field.csv'),(b'x'*(32*1024*1024+1),'oversize.json'),(b'x'*8_000_001,'oversize.csv')]
        duplicate=copy.deepcopy(exported);duplicate['portfolio']['assets'][1]['ticker']=duplicate['portfolio']['assets'][0]['ticker'];invalids.append((json.dumps(duplicate).encode(),'duplicate.json'))
        invalid_date=copy.deepcopy(exported);invalid_date['portfolio']['assets'][0]['securityAsOf']='2026-02-30';invalids.append((json.dumps(invalid_date).encode(),'invalid-catalog-date.json'))
        invalid_mode=copy.deepcopy(exported);invalid_mode['portfolio']['assets'][0]['feeMode']='trusted';invalids.append((json.dumps(invalid_mode).encode(),'invalid-fee-mode.json'))
        too_many=copy.deepcopy(exported);too_many['portfolio']['assets'].append({**too_many['portfolio']['assets'][0],'id':'extra','ticker':'EXTRA'});invalids.append((json.dumps(too_many).encode(),'101-assets.json'))
        too_many_snapshots=copy.deepcopy(exported);too_many_snapshots['snapshots'].append({**too_many_snapshots['snapshots'][0],'id':'extra'});invalids.append((json.dumps(too_many_snapshots).encode(),'51-snapshots.json'))
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
        # Legal full names can make the old pretty-printed export exceed its
        # own import cap. Reimport the actual download bytes, never a Python
        # reserialization which could hide that defect by shrinking the file.
        long_data=copy.deepcopy(data)
        long_data['version']=3
        long_portfolios=[long_data['portfolio'],long_data['beforeEstimate']]+[s[key] for s in long_data['snapshots'] for key in ['portfolio','sourcePortfolio']]
        for item in long_portfolios:
            for a in item['assets']:
                a.update(name='股'*110,shortName='股'*20,feeMode='manual')
        long_input=json.dumps(long_data,ensure_ascii=False,separators=(',',':')).encode()
        pretty_size=len(json.dumps(long_data,ensure_ascii=False,indent=2).encode())
        report['measurements']['long_names_input_utf8_bytes']=len(long_input)
        report['measurements']['long_names_pretty_utf8_bytes']=pretty_size
        check('Long-name fixture reproduces the former 8 MB export boundary',len(long_input)<8_000_000<pretty_size)
        upload(long_input,'long-names.json');page.get_by_role('button',name='確認載入',exact=True).click()
        expect(field).to_have_value('100000')
        expect(panel).to_contain_text(re.compile('已保存於此瀏覽器|保存失敗'),timeout=15000)
        report['measurements']['long_names_storage_status']=panel.inner_text()
        with page.expect_download() as downloaded:
            page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
        long_export_bytes=Path(downloaded.value.path()).read_bytes()
        long_export=json.loads(long_export_bytes)
        report['measurements']['long_names_export_utf8_bytes']=len(long_export_bytes)
        check('Long-name export remains within the JSON import limit',len(long_export_bytes)<=32*1024*1024)
        field.fill('123456')
        upload(long_export_bytes,'long-names-original-download.json')
        page.get_by_role('button',name='確認載入',exact=True).click()
        expect(field).to_have_value('100000')
        expect(panel).to_contain_text(re.compile('已保存於此瀏覽器|保存失敗'),timeout=15000)
        with page.expect_download() as downloaded:
            page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
        long_restored=json.loads(Path(downloaded.value.path()).read_bytes())
        long_export.pop('exported',None);long_restored.pop('exported',None)
        check('Original downloaded JSON restores 100 long names and 50 source snapshots even when local storage is full',long_restored==long_export and len(long_restored['portfolio']['assets'])==100 and len(long_restored['snapshots'])==50)
        check('V1, V2 and V3 saved data remain unchanged',page.evaluate("localStorage.getItem('433.portfolio.v1')==='v1-preserved' && localStorage.getItem('433.portfolio.v2')==='v2-preserved' && localStorage.getItem('433.portfolio.v3')==='v3-preserved'"))
        check('No JavaScript errors during pressure tests',not report['errors'])
    except Exception as error:
        report['failure']=str(error)
        page.screenshot(path=str(OUT/'pressure-failure.png'))
        raise
    finally:
        (OUT/'pressure.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report['measurements'],ensure_ascii=False),flush=True)
        browser.close()

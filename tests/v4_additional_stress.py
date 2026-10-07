"""Additional asynchronous editing, import and ticker stress regressions."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL','http://127.0.0.1:8013/433/').rstrip('/')+'/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4'); OUT.mkdir(parents=True,exist_ok=True)
report = {'checks':[], 'errors':[]}
def check(name, passed):
    report['checks'].append({'name':name,'passed':bool(passed)})
    print(('PASS: ' if passed else 'FAIL: ')+name,flush=True)
def fresh(browser):
    ctx=browser.new_context(accept_downloads=True)
    page=ctx.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
    page.on('dialog',lambda d:d.accept())
    page.goto(BASE+'versions/v4/',wait_until='networkidle')
    expect(page.get_by_label('官方標的名錄')).to_contain_text('收錄')
    page.get_by_label('現金餘額',exact=True).fill('100000')
    return ctx,page
def exported(page):
    with page.expect_download() as event:page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
    return json.loads(Path(event.value.path()).read_text())
def upload(page,data):
    page.locator('input[type=file]').set_input_files({'name':'same-ids.json','mimeType':'application/json','buffer':json.dumps(data).encode()})
    page.get_by_role('button',name='確認載入',exact=True).click()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    try:
        ctx,page=fresh(browser)
        page.get_by_role('button',name='＋ 新增標的',exact=True).click()
        ticker=page.get_by_label('標的代號',exact=True)
        ticker.fill('NOTLISTED');ticker.press('Tab')
        ticker.fill('00662');ticker.press('Enter')
        a=exported(page)['portfolio']['assets'][0]
        check('Correcting an unmatched first lookup still applies the verified ETF default',a['feeMode']=='auto' and a['sellTaxRate']==.1)
        ctx.close()

        ctx,page=fresh(browser)
        page.get_by_role('button',name='＋ 新增標的',exact=True).click()
        field=page.get_by_label('標的代號',exact=True)
        asset_id=field.get_attribute('aria-controls').removeprefix('security-options-')
        a={'id':asset_id,'ticker':'00662','kind':'core','shares':10,'price':100,'target':None,'limit':'free','lot':1,'feeRate':.0285,'minFee':7,'sellTaxRate':.1,'feeMode':'manual'}
        p={'version':1,'assets':[a],'cash':100000,'settlement':0,'flow':0,'cashFloor':10,'cashTarget':None,'tolerance':2}
        upload(page,{'version':3,'portfolio':p,'snapshots':[],'evidence':[]})
        field=page.get_by_label('標的代號',exact=True);field.focus();field.press('Enter')
        actual=exported(page)['portfolio']['assets'][0]
        check('Import with an existing row ID cannot inherit its blank-row automatic fee intent',actual['feeMode']=='manual' and actual['feeRate']==.0285 and actual['minFee']==7)
        ctx.close()

        ctx,page=fresh(browser)
        page.evaluate('''() => {const real=File.prototype.text;File.prototype.text=function(){const text=real.call(this);if(this.name==='slow.csv')return new Promise(resolve=>{window.finishCSV=()=>text.then(resolve)});return text;}}''')
        csv='ticker,kind,shares,price,target,limit,lot,feeRate,minFee,sellTaxRate\n00662,core,10,100,,free,1,0.0285,7,0.1\n'
        page.locator('input[type=file]').set_input_files({'name':'slow.csv','mimeType':'text/csv','buffer':csv.encode()})
        page.wait_for_function('typeof window.finishCSV === "function"')
        page.get_by_label('現金餘額',exact=True).fill('123456')
        page.get_by_label('交割款（T+2，正收負付）',exact=True).fill('-1234')
        page.evaluate('window.finishCSV()')
        expect(page.get_by_role('button',name='確認載入',exact=True)).to_be_visible()
        page.get_by_label('現金餘額',exact=True).fill('234567')
        page.get_by_role('button',name='確認載入',exact=True).click()
        p=exported(page)['portfolio']
        check('CSV replaces only holdings and preserves cash edits during read and preview',p['cash']==234567 and p['settlement']==-1234 and p['assets'][0]['feeRate']==.0285)
        ctx.close()
    finally:
        browser.close()
        report['passed']=all(c['passed'] for c in report['checks']) and not report['errors']
        (OUT/'additional-stress.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
assert report['passed'],report

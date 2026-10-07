"""Real downloaded finance files, cross-context round trips and unsafe units."""
import csv
import io
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE=os.environ.get('PORTAL_URL','http://127.0.0.1:8013/433/').rstrip('/')+'/'
KEY='433.portfolio.v4'
OUT=Path('test-results/v4'); OUT.mkdir(parents=True,exist_ok=True)
report={'checks':[], 'errors':[]}
def check(name,condition):
    report['checks'].append({'name':name,'passed':bool(condition)})
    print(('PASS: ' if condition else 'FAIL: ')+name,flush=True)
    assert condition,name
def upload(page,raw,name):
    page.locator('input[type=file]').set_input_files({'name':name,'mimeType':'text/plain','buffer':raw})
def confirm(page):
    page.get_by_role('button',name='確認載入',exact=True).click()
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
def downloaded(page,button):
    with page.expect_download() as event:page.get_by_role('button',name=button,exact=True).click()
    return Path(event.value.path()).read_bytes()
def stored(page):return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
def encode_csv(rows):
    out=io.StringIO();csv.writer(out).writerows(rows);return out.getvalue().encode('utf-8-sig')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    ctx=browser.new_context(accept_downloads=True);page=ctx.new_page()
    page.on('pageerror',lambda e:report['errors'].append(str(e)))
    page.on('dialog',lambda d:d.accept())
    try:
        page.goto(BASE+'versions/v4/',wait_until='networkidle')
        p={'version':1,'cash':100000,'settlement':-1234,'flow':5000,'cashFloor':10,'cashTarget':75,'tolerance':2,'assets':[{'id':'test','ticker':'00662','name':' =基金,"甲"\n類','shortName':"'基金",'kind':'core','shares':123,'price':98.76,'target':25,'limit':'free','lot':1,'feeRate':.1425,'minFee':0,'sellTaxRate':.1,'feeMode':'manual'}]}
        b={'version':3,'state':'actual','portfolio':p,'snapshots':[{'id':'history','name':'歷史快照','date':'2026-10-07T00:00:00Z','kind':'actual','portfolio':p}],'evidence':[]}
        upload(page,json.dumps(b).encode(),'old.json');confirm(page)
        raw_json=downloaded(page,'匯出 JSON 備份'); exported=json.loads(raw_json)
        check('JSON includes self-contained financial units and a field dictionary',exported['financeFormat']['currency']=='TWD' and exported['financeFormat']['rateUnit']=='percent' and 'portfolio.settlement' in exported['financeFormat']['fields'])
        raw_csv=downloaded(page,'匯出持倉 CSV');rows=list(csv.reader(io.StringIO(raw_csv.decode('utf-8-sig'))))
        check('CSV carries share/percent units, TWD and actual holdings status',dict(zip(rows[0],rows[1]))['recordType']=='actual_holdings' and dict(zip(rows[0],rows[1]))['rateUnit']=='percent')
        plan_csv=downloaded(page,'匯出方案 CSV')
        before=stored(page);upload(page,plan_csv,'plan.csv')
        expect(page.get_by_text('匯入失敗：',exact=False)).to_contain_text('尚未成交')
        check('Plan report is explicitly rejected without changing real holdings',stored(page)==before and page.get_by_role('button',name='確認載入',exact=True).count()==0)

        # Import actual download bytes into a different browser storage context.
        target=browser.new_context(accept_downloads=True);other=target.new_page()
        other.on('pageerror',lambda e:report['errors'].append(str(e)))
        other.goto(BASE+'versions/v4/',wait_until='networkidle')
        upload(other,raw_json,'exported.json');confirm(other)
        check('Downloaded JSON restores all data in a separate browser context',stored(other)=={k:v for k,v in exported.items() if k!='financeFormat'})
        expect(other.locator('.storage-panel')).to_contain_text('內容與最近匯出相同')
        check('Export change detection stays accurate after dictionary is stripped', 'financeFormat' not in stored(other))
        other.reload();expect(other.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器')
        check('Restored backup survives reload',stored(other)['portfolio']==p and len(stored(other)['snapshots'])==1)

        # Reordered CSV must still preserve literal names and numeric costs.
        upload(other,encode_csv([list(reversed(r)) for r in rows]),'reordered.csv')
        expect(other.get_by_role('button',name='確認載入',exact=True)).to_be_visible()
        other.get_by_label('現金餘額',exact=True).fill('222222');confirm(other)
        current=stored(other)
        check('Reordered CSV imports names and costs while retaining latest cash and history',current['portfolio']['cash']==222222 and current['portfolio']['settlement']==-1234 and current['portfolio']['assets'][0]['name']==p['assets'][0]['name'] and current['portfolio']['assets'][0]['feeRate']==.1425 and len(current['snapshots'])==1)

        b['state']='estimate';b['beforeEstimate']=p
        upload(page,json.dumps(b).encode(),'estimate.json');confirm(page)
        estimate_csv=downloaded(page,'匯出持倉 CSV');upload(other,estimate_csv,'estimate.csv')
        expect(other.get_by_text('載入後狀態：待成交核對',exact=False)).to_be_visible();confirm(other)
        check('Estimate CSV cannot silently become an actual holding',stored(other)['state']=='estimate')
        upload(other,raw_csv,'actual.csv');confirm(other)
        check('Importing actual CSV does not clear an existing unconfirmed state',stored(other)['state']=='estimate')
        baseline=stored(other)
        for bad,name in [(raw_csv.replace(b'"TWD"',b'"USD"'),'usd.csv'),(raw_csv.replace(b'"percent"',b'"decimal"'),'rates.csv'),(raw_csv.replace(b'"share"',b'"lot"'),'lots.csv'),(raw_json.replace(b'"currency":"TWD"',b'"currency":"USD"'),'usd.json')]:
            upload(other,bad,name);expect(other.get_by_text('匯入失敗：',exact=False)).to_be_visible()
            check('Reject '+name+' atomically',stored(other)==baseline and other.get_by_role('button',name='確認載入',exact=True).count()==0)
        other.get_by_text('匯出檔案與其他財務系統交換',exact=True).click()
        with other.expect_download() as event:other.get_by_role('link',name='下載財務欄位說明',exact=True).click()
        guide=json.loads(Path(event.value.path()).read_bytes())
        check('Published field guide downloads under the Pages subpath',guide['id']=='433-finance' and guide['fields']==exported['financeFormat']['fields'])
        # Valid JSON can hold long manual codes; do not emit an unreadable CSV.
        b['portfolio']['assets'][0]['ticker']='='+'0'*1023
        upload(other,json.dumps(b).encode(),'long-code.json');confirm(other)
        other.get_by_role('button',name='匯出持倉 CSV',exact=True).click()
        expect(other.get_by_text('匯出失敗：',exact=False)).to_contain_text('改用 JSON')
        check('Oversized escaped CSV fields give a recoverable error while JSON remains exportable',json.loads(downloaded(other,'匯出 JSON 備份'))['portfolio']['assets'][0]['ticker']==b['portfolio']['assets'][0]['ticker'])
        check('No browser JavaScript errors',not report['errors'])
        target.close()
    finally:
        (OUT/'interchange-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        browser.close()

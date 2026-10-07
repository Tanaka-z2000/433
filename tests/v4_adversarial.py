"""Divergent user workflows and hostile-but-valid IDs. Synthetic data only."""
import copy
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE=os.environ.get('PORTAL_URL','http://127.0.0.1:8013/433/').rstrip('/')+'/'
KEY='433.portfolio.v4'
OUT=Path('test-results/v4');OUT.mkdir(parents=True,exist_ok=True)
report={'checks':[],'errors':[]}
def fixture():
    p={'version':1,'cash':100000,'settlement':-1234,'flow':0,'cashFloor':10,'cashTarget':None,'tolerance':2,'assets':[{'id':'a','ticker':'00662','name':'合成測試','kind':'core','shares':100,'price':100,'target':None,'limit':'free','lot':1,'feeRate':.1425,'minFee':0,'sellTaxRate':.1,'feeMode':'manual'}]}
    return {'version':3,'state':'actual','portfolio':p,'snapshots':[{'id':'start','name':'起點快照','date':'2026-10-07T00:00:00Z','kind':'actual','portfolio':copy.deepcopy(p)}],'evidence':[]}
def upload(page,b):
    page.locator('input[type=file]').set_input_files({'name':'synthetic.json','mimeType':'application/json','buffer':json.dumps(b).encode()})
    page.get_by_role('button',name='確認載入',exact=True).click()
    expect(page.get_by_role('button',name='確認載入',exact=True)).to_have_count(0)
def download(page):
    with page.expect_download() as event:page.get_by_role('button',name='匯出 JSON 備份',exact=True).click()
    return json.loads(Path(event.value.path()).read_bytes())
def saved(page,predicate):
    page.wait_for_function('(key)=>{const raw=localStorage.getItem(key);if(!raw)return false;const b=JSON.parse(raw);return '+predicate+'}',arg=KEY,timeout=15000)
def run(browser,name,fn):
    ctx=browser.new_context(accept_downloads=True);page=ctx.new_page();errors=[]
    page.on('dialog',lambda d:d.accept());page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(BASE+'versions/v4/',wait_until='networkidle');upload(page,fixture())
        fn(ctx,page)
        assert not errors,errors
        report['checks'].append({'name':name,'passed':True});print('PASS: '+name,flush=True)
    except Exception as e:
        report['checks'].append({'name':name,'passed':False,'error':str(e)[:1500]});report['errors'].extend(errors)
        print('FAIL: '+name+' '+str(e)[:300],flush=True)
    finally:ctx.close()

def release(ctx,page):
    version=page.request.get(BASE+'release.json').json()['versions']
    release=next(v['release'] for v in version if v['id']=='v4')
    expect(page.locator('footer')).to_contain_text(release)
def restore_edit(ctx,page):
    page.locator('.snapshot-list').get_by_role('button',name='還原',exact=True).click()
    page.get_by_label('快照名稱',exact=True).fill('預覽期間新增')
    page.get_by_role('button',name='保存目前快照',exact=True).click()
    expect(page.locator('.snapshot-list > div')).to_have_count(2)
    page.get_by_role('button',name='確認載入',exact=True).click()
    assert any(s['name']=='預覽期間新增' for s in download(page)['snapshots'])
def demo_delete(ctx,page):
    page.get_by_role('button',name='載入示範',exact=True).click()
    page.locator('.snapshot-list').get_by_role('button',name='刪除',exact=True).click()
    page.get_by_role('button',name='確認載入',exact=True).click()
    assert download(page)['snapshots']==[]
def current_id(ctx,page):
    b=fixture();s=copy.deepcopy(b['snapshots'][0]);s.update(id='current',name='特殊識別碼快照');s['portfolio']['cash']=250000;b['snapshots'].append(s)
    upload(page,b)
    page.get_by_label('比較起點',exact=True).select_option('start')
    option=page.get_by_label('比較終點',exact=True).locator('option').filter(has_text='特殊識別碼快照')
    page.get_by_label('比較終點',exact=True).select_option(option.get_attribute('value'))
    expect(page.locator('.snapshot-comparison')).to_contain_text('總資產差額 $150,000')
def proto_id(ctx,page):
    b=fixture();b['portfolio']['assets'][0]['id']='constructor';upload(page,b)
    expect(page.locator('.scenario-table')).to_be_visible()
    expect(page.get_by_label('00662 漲跌 %',exact=True)).to_have_value('0')
    page.get_by_label('00662 漲跌 %',exact=True).fill('-100')
    expect(page.locator('.scenario-table')).to_contain_text('$98,766')
def deep_saved(ctx,page):
    raw=json.dumps(fixture(),separators=(',',':')).replace('"portfolio":{','"portfolio":{"extension":'+'['*10000+'0'+']'*10000+',',1)
    saved(page,'b.portfolio.cash===100000')
    page.evaluate('({key,raw})=>localStorage.setItem(key,raw)',{'key':KEY,'raw':raw})
    page.reload()
    expect(page.get_by_role('button',name='下載原始資料',exact=True)).to_be_visible()
    assert page.evaluate('(key)=>localStorage.getItem(key)',KEY)==raw
def stale_tab(ctx,page):
    saved(page,'b.portfolio.cash===100000')
    other=ctx.new_page();other.add_init_script("const on=window.addEventListener.bind(window);window.addEventListener=(name,...args)=>{if(name!=='storage')on(name,...args)};")
    other.goto(BASE+'versions/v4/',wait_until='networkidle')
    page.get_by_label('現金餘額',exact=True).fill('111111');saved(page,'b.portfolio.cash===111111')
    other.get_by_label('現金餘額',exact=True).fill('222222')
    expect(other.locator('.storage-panel')).to_contain_text('另一個分頁')
    assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).portfolio.cash',KEY)==111111
    assert download(other)['portfolio']['cash']==222222
def offline(ctx,page):
    ctx.set_offline(True)
    page.get_by_label('現金餘額',exact=True).fill('333333');saved(page,'b.portfolio.cash===333333')
    exported=download(page);assert exported['portfolio']['cash']==333333
    page.get_by_label('現金餘額',exact=True).fill('444444');upload(page,exported)
    saved(page,'b.portfolio.cash===333333')
    ctx.set_offline(False)
    page.reload();expect(page.get_by_label('現金餘額',exact=True)).to_have_value('333333')
def literal_markup(ctx,page):
    b=fixture();b['portfolio']['assets'][0]['name']='<img src=x onerror="window.pwned=1">';b['snapshots'][0]['name']='<script>window.pwned=1</script>'
    upload(page,b)
    assert page.evaluate('window.pwned') is None
    assert download(page)['snapshots'][0]['name']==b['snapshots'][0]['name']
def csv_confirm_state(ctx,page):
    b=fixture();b['state']='estimate';upload(page,b)
    csv=b'ticker,kind,shares,price,target,limit,lot,feeRate,minFee,sellTaxRate\n00662,core,100,100,,free,1,0.1425,0,0.1\n'
    page.locator('input[type=file]').set_input_files({'name':'legacy.csv','mimeType':'text/csv','buffer':csv})
    expect(page.get_by_role('button',name='確認載入',exact=True)).to_be_visible()
    page.get_by_role('button',name='已核對成交，標記為實際持倉',exact=True).click()
    page.get_by_role('button',name='確認載入',exact=True).click()
    assert download(page)['state']=='actual'

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
    for name,fn in [('Footer agrees with published release',release),('Snapshot restore preserves history edits during preview',restore_edit),('Demo preview cannot resurrect deleted snapshots',demo_delete),('Snapshot ID current does not alias live holdings',current_id),('Prototype-like holding ID has a neutral scenario',proto_id),('Deeply nested saved data offers recovery instead of a blank page',deep_saved),('A late storage event cannot overwrite another tab',stale_tab),('Already-open offline page saves exports and reimports',offline),('Markup in names remains literal data',literal_markup),('Legacy CSV preview preserves a later explicit actual-state confirmation',csv_confirm_state)]:run(browser,name,fn)
    browser.close()
(OUT/'adversarial-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
if any(not c['passed'] for c in report['checks']):raise SystemExit(1)

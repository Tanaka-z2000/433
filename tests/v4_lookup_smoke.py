"""V4 catalog integration and hostile lookup states in disposable contexts.

The first group uses the published static TWSE catalog. Remaining groups use
route fixtures to reproduce ambiguity, expiry and failure deterministically.
No real portfolio data is used or uploaded.
"""
import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PORTAL_URL', 'http://127.0.0.1:8013/433/').rstrip('/') + '/'
URL = BASE + 'versions/v4/'
KEY = '433.portfolio.v4'
OUT = Path('test-results/v4'); OUT.mkdir(parents=True, exist_ok=True)
REPORT = {'checks': [], 'errors': [], 'measurements': {}}
TODAY = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
XSS_NAME = '<img src=x onerror="window.nameInjected=true">股份有限公司'


def check(name, condition):
    REPORT['checks'].append({'name': name, 'passed': bool(condition)})
    print(('PASS: ' if condition else 'FAIL: ') + name, flush=True)
    assert condition, name


def catalog_fixture(as_of=TODAY):
    rows = [
        ('00662', '富邦NASDAQ-100證券投資信託基金', '富邦NASDAQ', 'equityETF'),
        ('2330', '台灣積體電路製造股份有限公司', '台積電', 'stock'),
        ('00675L', '富邦臺灣加權單日正向兩倍證券投資信託基金', '富邦臺灣加權正2', 'otherETF'),
        ('0050', '元大台灣卓越50證券投資信託基金', '元大台灣50', 'equityETF'),
        ('006208', '富邦台灣釆吉50證券投資信託基金', '富邦台50', 'equityETF'),
        ('3001', '同名股份有限公司', '同名一', 'stock'),
        ('3002', '同名股份有限公司', '同名二', 'stock'),
        ('9001', XSS_NAME, '測試文字', 'stock'),
        ('9002', '測試特殊商品', '特殊', 'unsupported'),
        ('00679B', '元大美國政府20年期以上債券證券投資信託基金', '元大美債20年', 'bondETF'),
    ]
    return {'schemaVersion': 1, 'asOf': as_of, 'fetchedAt': TODAY + 'T00:00:00Z',
        'sources': [{'id': 't187ap03_L', 'url': 'https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv',
            'asOf': as_of, 'sha256': 'a' * 64, 'rows': len(rows)}],
        'securities': [{'ticker': ticker, 'name': name, 'shortName': short, 'type': kind,
            'market': 'TWSE', 'currency': 'TWD', 'asOf': as_of, 'sourceIds': ['t187ap03_L']}
            for ticker, name, short, kind in rows]}


def new_page(browser, catalog=None, fail=False):
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda error: REPORT['errors'].append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    if fail:
        page.route('**/data/twse-securities.json', lambda route: route.abort())
    elif catalog is not None:
        page.route('**/data/twse-securities.json', lambda route: route.fulfill(
            status=200, content_type='application/json', body=json.dumps(catalog, ensure_ascii=False)))
    page.goto(URL)
    if fail:
        expect(page.get_by_label('官方標的名錄')).to_contain_text('載入失敗')
    else:
        expect(page.get_by_label('官方標的名錄')).to_contain_text('收錄')
    page.get_by_label('現金餘額', exact=True).fill('500000')
    return ctx, page


def add(page, ticker=None, name=None):
    page.get_by_role('button', name='＋ 新增標的', exact=True).click()
    card = page.locator('.asset-card').nth(page.locator('.asset-card').count() - 1)
    if ticker is not None:
        card.get_by_label('標的代號', exact=True).fill(ticker)
        card.get_by_label('標的代號', exact=True).press('Enter')
    if name is not None:
        card.get_by_label('標的全稱', exact=True).fill(name)
        card.get_by_label('標的全稱', exact=True).press('Enter')
    card.get_by_label('試算價格', exact=True).fill('100')
    return card


def saved(page):
    # React may update the inputs before its persistence effect marks the old
    # saved status as pending. Wait for paint/effects before reading durability.
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    expect(page.locator('.storage-panel')).to_contain_text('已保存於此瀏覽器', timeout=15000)
    return page.evaluate('(key) => JSON.parse(localStorage.getItem(key))', KEY)


def open_fees(card):
    details = card.locator('details').last
    if details.get_attribute('open') is None:
        card.get_by_text('交易單位與費用設定', exact=True).click()


def import_data(page, data):
    page.locator('input[type=file]').set_input_files({'name': 'lookup.json', 'mimeType': 'application/json',
        'buffer': json.dumps(data, ensure_ascii=False).encode()})
    page.get_by_role('button', name='確認載入', exact=True).click()


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'),
        headless=True, args=['--no-sandbox'])
    page = None
    try:
        # Validate the actual deployed artifact, including official names and fee defaults.
        ctx, page = new_page(browser)
        response = ctx.request.get(BASE + 'data/twse-securities.json')
        assert response.ok, 'Published static catalog must be available'
        actual_catalog = response.json()
        securities = {row['ticker']: row for row in actual_catalog['securities']}
        REPORT['measurements']['published_catalog_rows'] = len(securities)
        REPORT['measurements']['published_catalog_as_of'] = actual_catalog['asOf']
        check('Official catalog contains 00662 and 2330', '00662' in securities and '2330' in securities)
        requests = []
        page.on('request', lambda request: requests.append({'url': request.url, 'method': request.method, 'type': request.resource_type}))
        page.wait_for_load_state('networkidle')
        requests.clear()
        page.get_by_role('button', name='＋ 新增標的', exact=True).click()
        etf = page.locator('.asset-card').last
        etf.get_by_label('標的代號', exact=True).fill('00662')
        etf.get_by_label('標的代號', exact=True).press('Tab')
        expect(etf.get_by_label('標的全稱', exact=True)).to_have_value(securities['00662']['name'])
        etf.get_by_label('試算價格', exact=True).fill('100')
        etf.get_by_label('持有股數', exact=True).fill('100')
        data = saved(page)
        check('Typing 00662 and Tab fills its official full name and ETF costs',
            data['portfolio']['assets'][0]['feeMode'] == 'auto' and data['portfolio']['assets'][0]['sellTaxRate'] == .1
            and data['portfolio']['assets'][0]['feeRate'] == .1425 and data['portfolio']['assets'][0]['minFee'] == 0)
        stock = add(page, name=securities['2330']['name'])
        expect(stock.get_by_label('標的代號', exact=True)).to_have_value('2330')
        data = saved(page)
        check('Typing the official stock name fills 2330 and stock costs',
            data['portfolio']['assets'][1]['feeMode'] == 'auto' and data['portfolio']['assets'][1]['sellTaxRate'] == .3)
        check('All code/name searches issue zero subsequent network requests', not requests)
        # The new identity is retained by durable backup and by reload.
        with page.expect_download() as download:
            page.get_by_role('button', name='匯出 JSON 備份', exact=True).click()
        exported = json.loads(Path(download.value.path()).read_text())
        page.reload()
        expect(page.locator('.asset-card').first.get_by_label('標的全稱', exact=True)).to_have_value(securities['00662']['name'])
        check('Official full names and provenance survive backup and reload',
            exported['version'] == 3 and exported['portfolio']['assets'][0]['securityAsOf'] == securities['00662']['asOf'])
        ctx.close()

        # Deliberate fee edits and ambiguous lookups must never silently choose defaults.
        fixture = catalog_fixture()
        ctx, page = new_page(browser, fixture)
        changing = add(page, ticker='00662')
        initial = saved(page)['portfolio']['assets'][0]
        check('New 00662 starts with verified automatic ETF fees', initial['feeMode'] == 'auto' and initial['sellTaxRate'] == .1)
        changing.get_by_label('標的代號', exact=True).fill('2330')
        check('Editing an automatic identity keeps automatic intent but blocks unverified results',
            changing.get_by_label('標的全稱', exact=True).input_value() == '' and '費率來源：依商品預設' in changing.inner_text() and page.locator('.result-metrics').count() == 0)
        changing.get_by_label('標的代號', exact=True).press('Enter')
        switched = saved(page)['portfolio']['assets'][0]
        check('Changing automatic 00662 to 2330 recalculates stock sale tax to 0.3 percent',
            switched['ticker'] == '2330' and switched['feeMode'] == 'auto' and switched['sellTaxRate'] == .3 and switched['name'] == '台灣積體電路製造股份有限公司')
        changing.get_by_label('標的代號', exact=True).fill('00675L')
        changing.get_by_label('標的代號', exact=True).press('Enter')
        switched = saved(page)['portfolio']['assets'][0]
        check('Changing automatic stock to 00675L recalculates ETF sale tax to 0.1 percent',
            switched['ticker'] == '00675L' and switched['feeMode'] == 'auto' and switched['sellTaxRate'] == .1 and switched['kind'] == initial['kind'])
        changing.get_by_label('標的代號', exact=True).fill('00679B')
        changing.get_by_label('標的代號', exact=True).press('Enter')
        switched = saved(page)['portfolio']['assets'][0]
        check('Automatic fees switched to an unverified bond ETF stay blocked until manual confirmation',
            switched['ticker'] == '00679B' and switched['feeMode'] == 'auto' and switched['sellTaxRate'] == .1 and not switched.get('feeRuleId') and page.locator('.result-metrics').count() == 0)
        changing.get_by_label('標的代號', exact=True).fill('9002')
        changing.get_by_label('標的代號', exact=True).press('Enter')
        switched = saved(page)['portfolio']['assets'][0]
        check('An unsupported matched product cannot silently turn previous automatic fees into manual fees',
            switched['ticker'] == '9002' and switched['feeMode'] == 'auto' and not switched.get('feeRuleId') and page.locator('.result-metrics').count() == 0)
        changing.get_by_role('button', name='已核對費率，改為手動', exact=True).click()
        expect(page.locator('.result-metrics')).to_be_visible()
        check('Unsupported product fallback requires an explicit manual confirmation', saved(page)['portfolio']['assets'][0]['feeMode'] == 'manual')
        ctx.close()

        ctx, page = new_page(browser, fixture)
        card = add(page, ticker='2330'); open_fees(card)
        card.get_by_label('手續費率 %', exact=True).fill('0.07125')
        card.get_by_label('每筆最低手續費', exact=True).fill('7')
        card.get_by_label('標的全稱', exact=True).fill('元大台灣卓越50證券投資信託基金')
        check('Editing a verified name clears its old official code immediately', card.get_by_label('標的代號', exact=True).input_value() == '')
        check('Editing identity clears stale official provenance', '官方資料日' not in card.inner_text())
        card.get_by_label('標的全稱', exact=True).press('Enter')
        data = saved(page)['portfolio']['assets'][0]
        check('Selecting another security preserves manual discount and tax',
            data['ticker'] == '0050' and data['feeMode'] == 'manual' and data['feeRate'] == .07125 and data['minFee'] == 7 and data['sellTaxRate'] == .3)
        card.get_by_role('button', name='套用此商品預設', exact=True).click()
        data = saved(page)['portfolio']['assets'][0]
        check('Explicit preset resets the selected product fees and minimum to zero',
            data['feeMode'] == 'auto' and data['feeRate'] == .1425 and data['minFee'] == 0 and data['sellTaxRate'] == .1)
        fresh = add(page); open_fees(fresh)
        fresh.get_by_label('手續費率 %', exact=True).fill('0.05')
        fresh.get_by_label('標的代號', exact=True).fill('00662')
        fresh.get_by_label('標的代號', exact=True).press('Enter')
        data = saved(page)['portfolio']['assets'][1]
        check('Editing fees before the first lookup disables initial automatic replacement', data['feeMode'] == 'manual' and data['feeRate'] == .05)
        # Existing automatic metadata must not remain attached to a different typed code.
        card.get_by_label('標的代號', exact=True).fill('UNLISTED')
        check('An unknown automatic code clears stale identity and keeps calculation blocked',
            card.get_by_label('標的全稱', exact=True).input_value() == '' and '費率來源：依商品預設' in card.inner_text() and '官方資料日' not in card.inner_text() and page.locator('.result-metrics').count() == 0)
        card.get_by_label('標的代號', exact=True).press('Enter')
        card.get_by_label('標的全稱', exact=True).fill('人工核對名稱')
        card.get_by_label('標的全稱', exact=True).press('Enter')
        unresolved = saved(page)['portfolio']['assets'][0]
        check('Unresolved automatic identity remains blocked while its data can be saved', unresolved['ticker'] == 'UNLISTED' and unresolved['feeMode'] == 'auto' and page.locator('.result-metrics').count() == 0)
        card.get_by_role('button', name='已核對費率，改為手動', exact=True).click()
        check('Unknown securities become usable only after explicit manual fee confirmation', saved(page)['portfolio']['assets'][0]['ticker'] == 'UNLISTED' and saved(page)['portfolio']['assets'][0]['feeMode'] == 'manual')
        expect(page.locator('.result-metrics')).to_be_visible()
        ctx.close()

        ctx, page = new_page(browser, fixture)
        card = add(page)
        name = card.get_by_label('標的全稱', exact=True)
        name.fill('富邦')
        check('A partial name displays multiple candidates without picking one', card.locator('.security-options button').count() > 1 and card.get_by_label('標的代號', exact=True).input_value() == '')
        card.locator('.security-options').get_by_role('button', name='006208', exact=False).click()
        expect(card.get_by_label('標的代號', exact=True)).to_have_value('006208')
        check('Clicking the requested fuzzy candidate selects that exact security', saved(page)['portfolio']['assets'][0]['ticker'] == '006208')
        ambiguous = add(page)
        ambiguous.get_by_label('標的全稱', exact=True).fill('同名股份有限公司')
        ambiguous.get_by_label('標的全稱', exact=True).press('Enter')
        check('An identical name shared by two tickers is never auto-selected', ambiguous.get_by_label('標的代號', exact=True).input_value() == '')
        ambiguous.get_by_label('標的全稱', exact=True).click()
        ambiguous.locator('.security-options').get_by_role('button', name='3002', exact=False).click()
        expect(ambiguous.get_by_label('標的代號', exact=True)).to_have_value('3002')
        check('Ambiguous names resolve only to the candidate explicitly chosen', saved(page)['portfolio']['assets'][1]['ticker'] == '3002')
        ime = add(page)
        ime_name = ime.get_by_label('標的全稱', exact=True)
        ime_name.dispatch_event('compositionstart')
        ime_name.fill('台灣積體電路製造股份有限公司')
        ime_name.press('Enter')
        check('Enter during Chinese composition does not auto-select', ime.get_by_label('標的代號', exact=True).input_value() == '')
        ime_name.dispatch_event('compositionend')
        ime_name.press('Enter')
        expect(ime.get_by_label('標的代號', exact=True)).to_have_value('2330')
        check('The finalized Chinese name can be selected after composition ends', saved(page)['portfolio']['assets'][2]['ticker'] == '2330')
        xss = add(page, ticker='9001')
        expect(xss.get_by_label('標的全稱', exact=True)).to_have_value(XSS_NAME)
        check('Catalog names render as inert text instead of executable markup',
            xss.locator('img').count() == 0 and page.evaluate('window.nameInjected !== true'))
        for width in [320, 390, 768]:
            page.set_viewport_size({'width': width, 'height': 844})
            check(f'Long official names do not overflow the page at {width}px', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        page.screenshot(path=str(OUT / 'lookup-mobile.png'), full_page=True)
        leveraged = add(page, ticker='00675L')
        check('Confirmed leveraged ETFs use the verified 0.1 percent sale tax', saved(page)['portfolio']['assets'][-1]['feeMode'] == 'auto' and saved(page)['portfolio']['assets'][-1]['sellTaxRate'] == .1)
        # Unsupported tax categories are searchable but must never claim automatic fees.
        bond = add(page, ticker='00679B')
        expect(bond.get_by_role('button', name='套用此商品預設', exact=True)).to_be_disabled()
        check('Bond ETF names are available while unverified tax defaults remain manual', saved(page)['portfolio']['assets'][-1]['feeMode'] == 'manual' and '此商品未提供自動費率' in bond.inner_text())
        ctx.close()

        # Old automatic data needs revalidation; failure never prevents saving or backup.
        old_date = (datetime.fromisoformat(TODAY) - timedelta(days=46)).date().isoformat()
        stale = catalog_fixture(old_date)
        ctx, page = new_page(browser, stale)
        new = add(page, ticker='00662')
        check('Stale catalogs can fill names but cannot initialize automatic fees', saved(page)['portfolio']['assets'][0]['feeMode'] == 'manual')
        expect(new.get_by_role('button', name='套用此商品預設', exact=True)).to_be_disabled()
        stale_data = copy.deepcopy(saved(page))
        a = stale_data['portfolio']['assets'][0]
        a.update({'feeMode': 'auto', 'feeRuleId': 'tw-equityETF-2026-10-07', 'feeRate': .1425, 'minFee': 0, 'sellTaxRate': .1})
        import_data(page, stale_data)
        expect(page.locator('.results')).to_contain_text('官方名錄已過期')
        check('Stale automatic fees hide trade results, applying and plan downloads',
            page.locator('.result-metrics').count() == 0 and page.get_by_role('button', name='套用估計方案供核對', exact=True).count() == 0 and page.get_by_role('button', name='匯出方案 CSV', exact=True).count() == 0)
        expect(page.get_by_role('button', name='匯出 JSON 備份', exact=True)).to_be_enabled()
        saved(page)
        with page.expect_download() as download:
            page.get_by_role('button', name='匯出 JSON 備份', exact=True).click()
        check('Stale automatic data still saves and exports without losing identity', json.loads(Path(download.value.path()).read_text())['portfolio']['assets'][0]['ticker'] == '00662')
        stale_card = page.locator('.asset-card').first
        stale_card.get_by_label('標的代號', exact=True).fill('2330')
        stale_card.get_by_label('標的代號', exact=True).press('Enter')
        switched = saved(page)['portfolio']['assets'][0]
        check('Selecting another product from a stale catalog preserves automatic blocking and old numeric fees',
            switched['ticker'] == '2330' and switched['feeMode'] == 'auto' and switched['sellTaxRate'] == .1 and not switched.get('feeRuleId') and page.locator('.result-metrics').count() == 0)
        page.get_by_role('button', name='已核對費率，改為手動', exact=True).click()
        expect(page.locator('.result-metrics')).to_be_visible()
        check('Explicit manual confirmation unblocks calculation after expiry', saved(page)['portfolio']['assets'][0]['feeMode'] == 'manual')
        ctx.close()

        ctx, page = new_page(browser, fail=True)
        manual = add(page, ticker='UNKNOWN', name='手動商品名稱')
        check('Catalog failure still permits complete manual entry and persistence', saved(page)['portfolio']['assets'][0]['ticker'] == 'UNKNOWN')
        expect(manual.get_by_role('button', name='套用此商品預設', exact=True)).to_be_disabled()
        # Retry uses the same local catalog URL; user queries never become requests.
        page.unroute('**/data/twse-securities.json')
        page.route('**/data/twse-securities.json', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps(fixture)))
        page.get_by_role('button', name='重試載入名錄', exact=True).click()
        expect(page.get_by_label('官方標的名錄')).to_contain_text('收錄')
        check('Retry recovers catalog access without replacing manual portfolio data', manual.get_by_label('標的全稱', exact=True).input_value() == '手動商品名稱')
        ctx.close()
        check('No JavaScript runtime errors in lookup and failure scenarios', not REPORT['errors'])
    except Exception as error:
        REPORT['failure'] = str(error)
        if page and not page.is_closed():
            page.screenshot(path=str(OUT / 'lookup-failure.png'), full_page=True)
        raise
    finally:
        (OUT / 'lookup.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))
        browser.close()

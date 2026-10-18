#!/usr/bin/env python3
"""Exercise the real dashboard gates. Requires Python Playwright + Chromium,
the regtest stack, and seeded PASSBOOK_WALLETS / PASSBOOK_STATE paths.
Usage: python3 infra/browser-smoke.py standard margin cure lender-refuses
"""
import argparse
import base64
import json
import hashlib
import hmac
import os
import secrets
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('scenarios', nargs='*', default=['standard', 'margin', 'cure'])
parser.add_argument('--platform-off', action='store_true', help='Turn off the actual platform API after funding and verify the static/local display')
parser.add_argument('--report', default='data/browser-results.json')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
report = root / args.report
report.parent.mkdir(parents=True, exist_ok=True)
results = []

def signed(session, method, path, body):
    """Headers web/session-auth.js would send: HMAC-SHA256 over the request digest (src/server/auth.ts)."""
    sid, secret = session.split('.')
    ts, nonce = str(int(time.time() * 1000)), secrets.token_hex(16)
    digest = hashlib.sha256('\n'.join(['passbook-request-v1', method, path, ts, nonce, hashlib.sha256(body.encode()).hexdigest()]).encode()).hexdigest()
    mac = hmac.new(bytes.fromhex(secret), digest.encode(), hashlib.sha256).hexdigest()
    return {'content-type': 'application/json', 'x-passbook-session': sid, 'x-passbook-ts': ts, 'x-passbook-nonce': nonce, 'x-passbook-hmac': mac}

def rpc(method, params):
    credentials = f"{os.getenv('BITCOIND_USER', 'user')}:{os.getenv('BITCOIND_PASSWORD', 'password')}"
    request = urllib.request.Request(os.getenv('BITCOIND_URL', 'http://127.0.0.1:18443'),
        json.dumps({'jsonrpc': '1.0', 'id': 'smoke', 'method': method, 'params': params}).encode(),
        {'Content-Type': 'application/json', 'Authorization': 'Basic ' + base64.b64encode(credentials.encode()).decode()})
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.load(response)
        assert not body.get('error'), body.get('error')
        return body['result']

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    for scenario in args.scenarios:
        if scenario not in ('standard', 'margin', 'cure', 'lender-refuses', 'atomic', 'atomic-platform-off'):
            raise ValueError('Unknown scenario: ' + scenario)
        command = ['npm', 'run', 'dev']
        if scenario.startswith('atomic'):
            command += ['--', '--atomic']
            if scenario == 'atomic-platform-off': command += ['--platform-off']
        elif scenario == 'lender-refuses': command += ['--', '--lender-refuses']
        elif scenario != 'standard': command += ['--', '--scenario', scenario]
        port = os.getenv('SMOKE_PORT', '4175')
        base = f'http://127.0.0.1:{port}'
        # The platform refuses unsigned writes; the dashboard signs them with this operator session (src/server/auth.ts).
        session = secrets.token_hex(8) + '.' + secrets.token_hex(32)
        log_path = report.parent / f'{scenario}-{os.getenv("PASSBOOK_AI", "rules")}.log'
        started = time.monotonic()
        log = log_path.open('w')
        process = subprocess.Popen(command, cwd=root, env={**os.environ, 'PASSBOOK_DASHBOARD_SESSION': session, 'PORT': port, 'PASSBOOK_DB': os.getenv('PASSBOOK_DB', ':memory:'), 'PASSBOOK_ORACLE': os.getenv('PASSBOOK_ORACLE', 'demo')},
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        page = browser.new_page()
        page.add_init_script("""window.__wire=[]; const NativeSource=window.EventSource;
          window.EventSource=class extends NativeSource {constructor(...args){super(...args);
            this.addEventListener('message',e=>window.__wire.push(JSON.parse(e.data)));}};""")
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        result = {'scenario': scenario, 'engine': os.getenv('PASSBOOK_AI', 'rules'), 'gates': []}
        results.append(result)
        try:
            for attempt in range(180):
                if process.poll() is not None: raise RuntimeError(log_path.read_text())
                try:
                    page.goto(base + '/#session=' + session, timeout=3000)
                    break
                except Exception: page.wait_for_timeout(500)
            page.wait_for_function("document.querySelector('#phone').textContent.length > 0")
            previous = None
            repay_started = None
            repay_wall = None
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                state = page.request.get(base + '/demo').json()
                waiting = state.get('waiting', {})
                if waiting.get('error'): raise RuntimeError(waiting['error'])
                signature = json.dumps(waiting, sort_keys=True)
                if signature != previous and waiting.get('waiting'):
                    previous = signature
                    kind = waiting['waiting']
                    result['gates'].append({'step': state['step'], 'kind': kind, 'stop': waiting.get('stop'),
                        'title': waiting.get('title'), 'seconds': round(time.monotonic() - started, 3)})
                    print(json.dumps(result['gates'][-1]), flush=True)
                    if kind == 'next':
                        if args.platform_off and waiting.get('title', '').startswith('Repay:') and state.get('platform_online'):
                            page.locator('#platform-off').click(timeout=5000)
                            statuses = [page.request.get(base + route).status for route in ('/state', '/orderbook', '/sandbox/pubkey')]
                            assert statuses == [503, 503, 503], statuses
                            result['platform_off_statuses'] = statuses
                        if 'Ladder:' in waiting.get('title', '') and repay_started:
                            page.wait_for_timeout(500)
                            assert 'Sending' not in page.locator('#phone').inner_text(), 'release must leave the Sending screen'
                            if scenario.startswith('atomic'):
                                proof = state['atomic_receipts'][0]
                                assert hashlib.sha256(bytes.fromhex(proof['preimage'])).hexdigest() == proof['payment_hash']
                                raw = rpc('getrawtransaction', [proof['release_txid'], True])
                                assert raw['confirmations'] >= 1 and raw['vin'][0]['txinwitness'][1] == proof['preimage']
                                page.get_by_role('button', name='Details and receipts').click(timeout=5000)
                                phone = page.locator('#phone').inner_text()
                                assert proof['preimage'] in phone and page.locator('[title="' + proof['release_txid'] + '"]').count() > 0
                                assert 'None needed' in phone and 'Repaid over Lightning' in phone
                                result['atomic_proof'] = proof
                                page.screenshot(path=str(report.parent / (scenario + '.png')), full_page=True)
                            if args.platform_off or scenario == 'atomic-platform-off':
                                local = page.request.get(base + '/demo/local').json()
                                assert local['passbook']['ladder']['step'] == 1
                                if scenario.startswith('atomic'): assert local['passbook']['assurance'][0] == 'bitcoin_hashlock'
                                else: assert local['passbook']['pages'][0]['repayment_txid']
                                result['offline_local_step'] = 1
                            result['repay_and_release_seconds'] = round(time.monotonic() - repay_started, 3)
                        page.locator('#next').click(timeout=5000)
                    elif kind == 'approve':
                        label = 'Share and apply' if waiting.get('items') else 'Apply'
                        page.locator('#phone button').filter(has_text=label).click(timeout=5000)
                    elif kind == 'confirm':
                        probe = json.dumps({'stop': waiting['stop'], 'accept': True, 'loan_id': 'wrong-loan'})
                        assert page.request.post(base + '/demo/confirm', data=probe, headers={'content-type': 'application/json'}).status == 401, 'unsigned writes are refused'
                        stale = page.request.post(base + '/demo/confirm', data=probe, headers=signed(session, 'POST', '/demo/confirm', probe)).json()
                        assert stale['ok'] is False, 'confirmation must bind to this loan'
                        if waiting['stop'] in ('lender-approve', 'checker-approve'):
                            assert 'Term-sheet hash' in page.locator('#approval-body').inner_text()
                            page.locator('#approval-body button').filter(has_text='Approve').first.click(timeout=5000)
                            continue
                        if waiting['stop'] == 'fee':
                            page.locator('#fee-rows button').filter(has_text='Pay ').first.click(timeout=5000)
                            continue
                        if waiting['stop'] == 'accept':
                            page.get_by_role('button', name='What am I agreeing to?').click(timeout=5000)
                            assert waiting['explanation'] in page.locator('#phone').inner_text()
                            result.setdefault('term_explanations', []).append(waiting['explanation'])
                        if scenario.startswith('atomic') and waiting.get('atomic_repayment'):
                            assert '3,000 sats' in page.locator('#phone').inner_text(), 'additional BTC payment must be disclosed before signing or paying'
                        if waiting['stop'] == 'repay':
                            repay_started = time.monotonic()
                            repay_wall = time.time()
                        label = ('Approve and lock' if waiting.get('termsheet') else 'Lock and accept') if waiting['stop'] == 'accept' else 'Pay '
                        page.locator('#phone button').filter(has_text=label).last.click(timeout=5000)
                end = 10 if scenario in ('standard', 'lender-refuses', 'atomic', 'atomic-platform-off') else 11
                if state['step'] >= end and not waiting.get('waiting') and 'done' in log_path.read_text():
                    book = page.request.get(base + '/passbook/' + state['borrower_pk']).json()
                    txids = {item[key] for item in book['pages'] for key in ('lock_txid', 'close_txid', 'repayment_txid') if item.get(key)}
                    for txid in txids: assert rpc('getrawtransaction', [txid, True])['confirmations'] >= 1
                    wire = page.evaluate('window.__wire')
                    if scenario.startswith('atomic'):
                        assert not any(event.get('title') == 'Release co-signed (leaf A)' for event in wire), 'atomic release needs no lender co-sign'
                        if scenario == 'atomic-platform-off': assert any(event.get('type') == 'platform_offline' for event in wire)
                    settled = next((event for event in wire if event.get('title') == 'Repaid over RGB'), None)
                    if settled and repay_wall:
                        result['repayment_rgb_settled_seconds'] = round(settled['at'] / 1000 - repay_wall, 3)
                    result.update(completed=True, seconds=round(time.monotonic() - started, 3),
                        confirmed_txids=sorted(txids), browser_errors=errors)
                    assert not errors, errors
                    break
                page.wait_for_timeout(150)
            else: raise TimeoutError('Dashboard scenario did not finish')
        finally:
            page.close()
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            process.wait(timeout=20)
            log.close()
            report.write_text(json.dumps(results, indent=2) + '\n')
    browser.close()

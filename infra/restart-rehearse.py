#!/usr/bin/env python3
"""Real-node restart/replay rehearsal. Requires an explicitly isolated Compose stack."""
import argparse, base64, hashlib, hmac, json, os, secrets, signal, subprocess, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--mode', choices=['legacy', 'atomic'], default='legacy')
parser.add_argument('--ai', choices=['rules', 'qvac'], help='default: rules for legacy, qvac for atomic. Atomic with rules runs the legacy borrower over RGB Lightning (no GPU).')
parser.add_argument('--platform-on', action='store_true', help='keep the platform API online after funding, so loan 1 closes into the lender fee stop, which is also restarted')
parser.add_argument('--maker-checker-usdt', type=int, help='lower the maker-checker threshold below the 600 USDT loan, so the second lender approver gate appears and is restarted')
parser.add_argument('--report', required=True)
args = parser.parse_args()
ai = args.ai or ('rules' if args.mode == 'legacy' else 'qvac')
# The default showcase (Fatima, QVAC, Lightning) turns the API off itself after funding.
showcase_flags = ['--legacy'] if args.mode == 'legacy' else ['--legacy', '--atomic'] if ai == 'rules' else []
assert not (args.platform_on and not showcase_flags), '--platform-on needs a --legacy showcase; the default one turns the API off itself'
required = ['COMPOSE_PROJECT_NAME', 'PASSBOOK_SHOWCASE_DIR', 'BITCOIND_URL', 'RGB_INDEXER_URL', 'RGB_TRANSPORT_URL', 'PASSBOOK_RELAYS', 'PORT']
assert all(os.getenv(key) for key in required), 'Explicit isolated project, paths and endpoints are required'
assert os.environ['COMPOSE_PROJECT_NAME'] not in ['passbook', 'passbook-lane-c', 'passbook-fees', 'passbook-restart', 'passbook-w1', 'passbook-bind'], 'Reserved showcase/proof stacks are forbidden'
home = Path(os.environ['PASSBOOK_SHOWCASE_DIR']).resolve()
assert home.is_relative_to(ROOT / 'data'), 'Use an ignored data/ directory in this worktree'
port = int(os.environ['PORT'])
assert port not in [4170, 4177, 4190, 4191, 4198], 'Reserved dashboard port'
base = f'http://127.0.0.1:{port}'
home.mkdir(parents=True, exist_ok=True)
log_file = home / 'rehearsal.log'
log = log_file.open('a')
proc = None
started = time.monotonic()
checks = []
report = {'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'mode': args.mode, 'ai': ai, 'platform_on': args.platform_on, 'maker_checker_usdt': args.maker_checker_usdt, 'showcase_flags': showcase_flags, 'evidence': f'Real local Bitcoin, native RGB wallets and Nostr{", RGB Lightning" if args.mode == "atomic" else ""}; controlled approval-gate restarts; {ai} reasoner.', 'checks': checks}

# Demo writers refuse unsigned writes (src/server/auth.ts). The supervisor hands this operator session
# to every writer, and each write is signed the way web/session-auth.js signs dashboard requests.
SESSION = os.getenv('PASSBOOK_DASHBOARD_SESSION') or f'{secrets.token_hex(8)}.{secrets.token_hex(32)}'
def signed(method, path, data):
    sid, secret = SESSION.split('.')
    ts, nonce = str(int(time.time() * 1000)), secrets.token_hex(16)
    digest = hashlib.sha256('\n'.join(['passbook-request-v1', method, path, ts, nonce, hashlib.sha256(data.encode()).hexdigest()]).encode()).hexdigest()
    return {'x-passbook-session': sid, 'x-passbook-ts': ts, 'x-passbook-nonce': nonce, 'x-passbook-hmac': hmac.new(bytes.fromhex(secret), digest.encode(), hashlib.sha256).hexdigest()}

def http(path, body=None, headers=None, allow_error=False):
    data = None if body is None else json.dumps(body)
    request = urllib.request.Request(base + path, None if data is None else data.encode(), {'Content-Type': 'application/json', **({} if data is None else signed('POST', path, data)), **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        if allow_error: return error.code, json.load(error)
        raise

def session(): return http('/showcase/session')[1]
def post(path, body):
    current = session()
    return http(path, body, {'x-passbook-demo-run': current['current']['id'], 'x-passbook-demo-generation': current['generation']})[1]
def wait_ready():
    end = time.monotonic() + 360
    while time.monotonic() < end:
        if proc.poll() is not None: raise RuntimeError('Supervisor exited: ' + log_file.read_text()[-5000:])
        try:
            status = session()
            if status['phase'] == 'failed': raise AssertionError(status.get('error'))
            if status['phase'] == 'ready' and not status['changing']: return status
        except (urllib.error.URLError, TimeoutError, ConnectionError): pass
        time.sleep(.2)
    raise TimeoutError('showcase readiness: ' + log_file.read_text()[-5000:])
def start(fresh=False):
    global proc
    command = ['bash', 'infra/showcase.sh'] + (['--fresh'] if fresh else []) + showcase_flags
    env = {**os.environ, 'PASSBOOK_DASHBOARD_SESSION': SESSION, 'PASSBOOK_AI': ai, **({'PASSBOOK_MAKER_CHECKER_USDT': str(args.maker_checker_usdt)} if args.maker_checker_usdt is not None else {})}
    proc = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    return wait_ready()
def stop():
    global proc
    if proc and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGINT)  # terminal Ctrl-C reaches both parent and child
        proc.wait(timeout=100)
        assert proc.returncode == 0, proc.returncode
    proc = None

def drive(predicate):
    end = time.monotonic() + 420
    previous = None
    while time.monotonic() < end:
        state = http('/demo')[1]
        waiting = state.get('waiting') or {}
        if waiting.get('error'): raise AssertionError(waiting['error'])
        status = session()
        if status.get('error'): raise AssertionError(status['error'])
        if predicate(state, waiting, status): return state
        signature = json.dumps(waiting, sort_keys=True)
        if waiting.get('waiting') and signature != previous:
            previous = signature
            kind = waiting['waiting']
            if kind == 'next': answer = post('/demo/next', {})
            elif kind == 'approve': answer = post('/demo/approve', {'txids': [item['txid'] for item in waiting['items']]})
            elif kind == 'confirm': answer = post('/demo/confirm', {'accept': True, 'stop': waiting['stop'], 'loan_id': waiting['loan_id']})
            else: raise AssertionError(waiting)
            assert answer['ok'], answer
        time.sleep(.15)
    raise TimeoutError('story stalled: ' + log_file.read_text()[-5000:])

# Gates by title and stop: W1 added a Negotiate step and the lender's term-sheet approval, so numbers moved.
def next_gate(title): return lambda state, waiting, status: waiting.get('waiting') == 'next' and waiting.get('title', '').startswith(title)
def stop_at(stop, loans=None): return lambda state, waiting, status: waiting.get('waiting') == 'confirm' and waiting.get('stop') == stop and (loans is None or len(http('/demo/local')[1]['state']['loans']) == loans)

def restart(label, delay=0):
    before_session = session()
    before = http('/demo')[1]
    local = http('/demo/local')[1]
    wallet = http('/demo/wallet')[1]
    stop()
    if delay: time.sleep(delay)
    after_session = start()
    assert not after_session['inspection'], (label, after_session)
    after = http('/demo')[1]
    new_local = http('/demo/local')[1]
    new_wallet = http('/demo/wallet')[1]
    assert after_session['current']['id'] == before_session['current']['id']
    assert after['asset_id'] == before['asset_id'] and after['borrower_pk'] == before['borrower_pk']
    assert after['step'] == before['step'] and after['waiting'] == before['waiting'], (label, before, after)
    assert new_local['state']['height'] == local['state']['height'], label
    assert new_local['state']['loans'] == local['state']['loans'], label
    for key in ['usdt_settled', 'usdt_future', 'btc_free_sats']:
        assert new_wallet.get(key) == wallet.get(key), (label, key, wallet, new_wallet)
    assert after['platform_online'] == before['platform_online'], label
    checks.append({'check': label, 'pass': True, 'step': after['step'], 'gate': after['waiting']['waiting'], 'height': new_local['state']['height'], 'loans': len(new_local['state']['loans']), 'shutdown_gap_seconds': delay})
    print(label + ': PASS', flush=True)

try:
    initial = start(True)
    assert not initial['inspection']
    first = initial['current']
    restart('restart before first step')
    drive(next_gate('Underwrite'))  # APPLICATION exists on relay, underwriting has not consumed it
    restart('restore application after relay replay window', 6)
    drive(stop_at('lender-approve'))  # term sheet built and journaled, not registered or sent
    restart('restore lender term-sheet approval')
    if args.maker_checker_usdt is not None:
        drive(stop_at('checker-approve'))  # the first approval answered; the second lender key still has to approve
        restart('restore second lender approver (maker-checker)')
    drive(stop_at('accept', 1))  # sheet registered and sent; lender keeps sheet, approvals and policy
    restart('restore negotiated acceptance before the borrower approves')
    drive(next_gate('Repay'))  # funded, awaiting repayment
    if args.platform_on: assert http('/state', allow_error=True)[0] == 200
    else:
        if showcase_flags: post('/demo/platform-off', {})
        assert http('/state', allow_error=True)[0] == 503
    restart('restore funded loan and existing repayment account')
    drive(stop_at('repay'))
    restart('restore repayment confirmation with platform ' + ('online' if args.platform_on else 'offline'))
    if args.platform_on:
        drive(stop_at('fee'))  # loan 1 closed; the platform invoiced lender 1's share of the interest
        restart('restore lender platform-fee approval')
    drive(stop_at('accept', 2))
    restart('restore second-lender signed sandbox result')
    drive(lambda state, waiting, status: status['current']['status'] == 'complete')
    result = http('/demo/local')[1]
    assert len(result['state']['loans']) == 2, result
    assert sorted(loan['status'] for loan in result['state']['loans']) == ['open', 'repaid'], result
    assert result['passbook']['ladder']['step'] == 1 and result['passbook']['unverified'] == 0, result
    report['loan_receipts'] = [{'id': loan['id'], 'status': loan['status']} for loan in result['state']['loans']]
    report['passbook'] = result['passbook']
    seed_files = sorted(Path(first['paths']['wallets']).rglob('seed'))
    assert seed_files, 'No native wallet seed files found for preservation check'
    # Hash state and seed identity, never publish secret contents.
    preserved = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(first['paths']['state']), *seed_files]}
    old = session()
    answer = post('/showcase/restart', {'token': old['token'], 'current': first['id'], 'generation': old['generation']})
    assert answer['ok']
    second = wait_ready()
    assert second['current']['id'] != first['id'] and not second['inspection']
    assert http('/demo')[1]['asset_id'] != result['state']['loans'][0]['terms']['asset_id']
    assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest for path, digest in preserved.items())
    stale_headers = {'x-passbook-demo-run': first['id'], 'x-passbook-demo-generation': old['generation']}
    assert http('/demo/next', {}, stale_headers, True)[0] == 409
    checks.append({'check': 'new run has distinct wallets/asset and preserves previous state; stale tab rejected', 'pass': True})
    current = session()
    post('/showcase/restart', {'token': current['token'], 'current': current['current']['id'], 'generation': current['generation'], 'inspect': first['id']})
    inspected = wait_ready()
    assert inspected['inspection'] and inspected['current']['id'] == first['id']
    headers = {'x-passbook-demo-run': first['id'], 'x-passbook-demo-generation': inspected['generation']}
    assert http('/demo/next', {}, headers, True)[0] == 409
    checks.append({'check': 'retained completed run opens read-only', 'pass': True})
    current = session()
    post('/showcase/restart', {'token': current['token'], 'current': first['id'], 'generation': current['generation'], 'resume': second['current']['id']})
    resumed = wait_ready()
    assert not resumed['inspection'] and resumed['current']['id'] == second['current']['id']
    checks.append({'check': 'resume saved run from dashboard', 'pass': True})
    report.update({'pass': True, 'seconds': round(time.monotonic() - started, 3), 'runs': [first['id'], second['current']['id']]})
finally:
    stop()
    log.close()
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')

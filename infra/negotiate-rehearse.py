#!/usr/bin/env python3
"""Negotiated two-process peer rehearsal over the Nostr relay (src/market/negotiate-nostr.ts).

A lender peer (`--negotiate`, its governance gate and offline sanctions screen on) and a borrower
peer, two separate Node processes with their own keys, negotiate over the relay, then the loan
is underwritten (platform rules sandbox), approved by both, locked, funded, repaid and released
on regtest. Fresh wallets, state and platform DB per run under the given private directory.
Runs against an already-running, isolated regtest stack; it never starts, stops or resets Docker.

Usage: BITCOIND_URL=... RGB_INDEXER_URL=... RGB_TRANSPORT_URL=... PASSBOOK_RELAYS=... \
  python3 infra/negotiate-rehearse.py --port 4331 --dir data/negnostr-run --report data/negnostr-run/report.json
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, required=True, help='platform HTTP port')
parser.add_argument('--dir', required=True, help='fresh private directory for wallets, state, DB and logs')
parser.add_argument('--report', required=True)
parser.add_argument('--principal', default='600')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
directory = (root / args.dir).resolve()
if directory.exists() and any(directory.iterdir()):
    raise ValueError(f'{directory} is not empty: every run uses fresh wallets and state')
directory.mkdir(parents=True, exist_ok=True)
report_path = (root / args.report).resolve()
for name in ('BITCOIND_URL', 'RGB_INDEXER_URL', 'RGB_TRANSPORT_URL', 'PASSBOOK_RELAYS'):
    if not os.environ.get(name):
        raise ValueError(f'{name} must name the isolated stack explicitly')


def rpc(method, params=None):
    credentials = f"{os.getenv('BITCOIND_USER', 'user')}:{os.getenv('BITCOIND_PASSWORD', 'password')}"
    request = urllib.request.Request(os.environ['BITCOIND_URL'],
        json.dumps({'jsonrpc': '1.0', 'id': 'negotiate-rehearsal', 'method': method, 'params': params or []}).encode(),
        {'Content-Type': 'application/json', 'Authorization': 'Basic ' + base64.b64encode(credentials.encode()).decode()})
    with urllib.request.urlopen(request, timeout=5) as response:
        data = json.load(response)
        if data.get('error'):
            raise RuntimeError(data['error'])
        return data['result']


if rpc('getblockchaininfo')['chain'] != 'regtest':
    raise ValueError('rehearsal requires an explicitly configured regtest node')
env = {**os.environ, 'PASSBOOK_WALLETS': str(directory / 'wallets'),
    'PASSBOOK_STATE': str(directory / 'state.json'), 'PASSBOOK_DB': str(directory / 'platform.sqlite'),
    'PASSBOOK_CHAIN': 'bitcoind', 'PASSBOOK_AI': 'rules', 'PASSBOOK_ORACLE': 'demo',
    'BLOCKS_PER_MONTH': '30', 'HOST': '127.0.0.1', 'PORT': str(args.port),
    'PASSBOOK_URL': f'http://127.0.0.1:{args.port}'}
for name in ('PLATFORM_SECRET', 'SANDBOX_URL', 'PASSBOOK_BORROWER_LIGHTNING_URL', 'PASSBOOK_LENDER_LIGHTNING_URL'):
    env.pop(name, None)
processes, logs = [], []
started = time.monotonic()
result = {'completed': False, 'artifacts': str(directory)}


def spawn(command, name, process_env):
    log = (directory / f'{name}.log').open('w')
    logs.append(log)
    process = subprocess.Popen(command, cwd=root, env=process_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(process)
    return process


def wait_log(process, name, needle, seconds=60):
    for _ in range(seconds * 10):
        if process.poll() is not None:
            raise RuntimeError((directory / f'{name}.log').read_text())
        if needle in (directory / f'{name}.log').read_text():
            return
        time.sleep(.1)
    raise TimeoutError(f'{name}: {needle} not seen')


try:
    print(json.dumps({'phase': 'seed', 'private_artifacts': str(directory)}), flush=True)
    with (directory / 'seed.log').open('w') as log:
        if subprocess.run(['npm', 'run', 'seed'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=300).returncode:
            raise RuntimeError((directory / 'seed.log').read_text())
    state = json.loads((directory / 'state.json').read_text())
    result['seed_seconds'] = round(time.monotonic() - started, 3)
    server = spawn(['npm', 'run', 'server'], 'server', env)
    for _ in range(300):
        if server.poll() is not None:
            raise RuntimeError((directory / 'server.log').read_text())
        try:
            with urllib.request.urlopen(env['PASSBOOK_URL'] + '/state', timeout=2) as response:
                if json.load(response)['platform_pk'] != state['platform_pk']:
                    raise ValueError('platform port belongs to another seed')
            break
        except OSError:
            time.sleep(.1)
    else:
        raise TimeoutError('platform did not become ready')
    peer_started = time.monotonic()
    # The lender never reads the borrower's private state.
    lender_env = {**env, 'PASSBOOK_STATE': str(directory / 'intentionally-absent-private-state.json')}
    lender = spawn(['npm', 'run', 'peer', '--', '--role', 'lender', '--wallet', 'lender1', '--asset-id', state['asset']['id'],
        '--negotiate', '--auto-approve', '--output', str(directory / 'lender-result.json')], 'lender', lender_env)
    wait_log(lender, 'lender', '"event":"offer_ready"')
    borrower = spawn(['npm', 'run', 'peer', '--', '--role', 'borrower', '--lender-wallet', 'lender1', '--principal', args.principal,
        '--negotiate', '--auto-approve', '--output', str(directory / 'borrower-result.json')], 'borrower', env)
    for name, process in [('borrower', borrower), ('lender', lender)]:
        if process.wait(timeout=600):
            raise RuntimeError(f'{name} failed:\n' + (directory / f'{name}.log').read_text()[-6000:])
    b = json.loads((directory / 'borrower-result.json').read_text())
    l = json.loads((directory / 'lender-result.json').read_text())
    assert b['pid'] != l['pid'], 'the peers must be separate Node processes'
    assert b['actor_pk'] != l['actor_pk'], 'the peers must use distinct keys'
    for field in ('loan_id', 'asset_id', 'disbursement_txid', 'repayment_txid', 'release_txid'):
        assert b[field] == l[field], field
    bn, ln = b['negotiation'], l['negotiation']
    assert bn['negotiation_id'] == ln['negotiation_id'] and bn['transcript_hash'] == ln['transcript_hash'], 'one transcript, held by both'
    assert bn['verified'] and ln['verified'], 'both sides verified the transcript'
    agreed = ln['agreed']
    assert bn['outcome'] == {'agreed': agreed}
    assert 1000 <= agreed['apr_bps'] <= 1200, f'agreed APR {agreed["apr_bps"]} inside both signed policies'
    assert ln['borrower_pk'] == b['actor_pk']
    kinds = [d['kind'] for d in l['lender_decisions']]
    assert 'sanctions-result' in kinds and 'approval' in kinds, kinds
    lender_hashes = {d['hash'] for d in l['lender_decisions']}
    assert b['lender_decisions'] and all(d['hash'] in lender_hashes for d in b['lender_decisions']), 'the borrower received the lender node\'s decision-log entries'
    txids = sorted({b[name] for name in ('lock_txid', 'disbursement_txid', 'repayment_txid', 'iou_return_txid', 'release_txid')})
    confirmations = {txid: rpc('getrawtransaction', [txid, True])['confirmations'] for txid in txids}
    assert all(c >= 1 for c in confirmations.values()), confirmations
    doc = json.loads((directory / 'wallets' / 'borrower' / 'passbook.json').read_text())
    assert len(doc['pages']) == 1 and doc['pages'][0]['outcome'] == 'repaid'
    result.update({'completed': True, 'peer_seconds': round(time.monotonic() - peer_started, 3), 'lender_private_state_absent': True,
        'borrower': b, 'lender': l, 'confirmed_txids': confirmations, 'height': rpc('getblockcount')})
    print(json.dumps({'completed': True, 'peer_seconds': result['peer_seconds'], 'loan_id': b['loan_id'], 'negotiation_id': ln['negotiation_id'], 'agreed': agreed}), flush=True)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)
    for log in logs:
        log.close()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({'evidence': 'Two separate Node peer processes (lender --negotiate with its governance gate and offline sanctions screen; borrower --negotiate) on one host, negotiating over a real nostr-rs-relay, then a real regtest loan; fresh wallets; platform rules sandbox; explicitly auto-approved rehearsal (labelled); test USDT issued locally; no mainnet, no Lightning', **result}, indent=2) + '\n')

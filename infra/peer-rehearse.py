#!/usr/bin/env python3
"""Two-process legacy peer rehearsal on an already-running shared regtest stack.
No Docker reset, model inference, physical-machine claim or wallet reuse.
Usage: BITCOIND_URL=... RGB_INDEXER_URL=... RGB_TRANSPORT_URL=... PASSBOOK_RELAYS=... \
  python3 infra/peer-rehearse.py --runs 2 --report docs/PEER-REHEARSAL.json
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runs', type=int, default=2)
parser.add_argument('--port', type=int, default=4197)
parser.add_argument('--report', default='data/peer-rehearsal.json')
args = parser.parse_args()
if not 1 <= args.runs <= 5:
    raise ValueError('--runs must be 1..5')
root = Path(__file__).resolve().parent.parent
report_path = root / args.report
report_path.parent.mkdir(parents=True, exist_ok=True)


def rpc(method, params=None):
    url = os.environ['BITCOIND_URL']
    credentials = f"{os.getenv('BITCOIND_USER', 'user')}:{os.getenv('BITCOIND_PASSWORD', 'password')}"
    request = urllib.request.Request(url,
        json.dumps({'jsonrpc': '1.0', 'id': 'peer-rehearsal', 'method': method, 'params': params or []}).encode(),
        {'Content-Type': 'application/json', 'Authorization': 'Basic ' + base64.b64encode(credentials.encode()).decode()})
    with urllib.request.urlopen(request, timeout=5) as response:
        data = json.load(response)
        if data.get('error'):
            raise RuntimeError(data['error'])
        return data['result']


if rpc('getblockchaininfo')['chain'] != 'regtest':
    raise ValueError('rehearsal requires an explicitly configured regtest node')
results = []
for number in range(1, args.runs + 1):
    directory = Path(tempfile.mkdtemp(prefix=f'passbook-two-peers-{number}-'))
    env = {**os.environ, 'PASSBOOK_WALLETS': str(directory / 'wallets'),
        'PASSBOOK_STATE': str(directory / 'state.json'), 'PASSBOOK_DB': str(directory / 'platform.sqlite'),
        'PASSBOOK_CHAIN': 'bitcoind', 'PASSBOOK_AI': 'rules', 'PASSBOOK_ORACLE': 'demo',
        'BLOCKS_PER_MONTH': '30', 'HOST': '127.0.0.1', 'PORT': str(args.port),
        'PASSBOOK_URL': f'http://127.0.0.1:{args.port}'}
    for name in ('PLATFORM_SECRET', 'SANDBOX_URL', 'PASSBOOK_BORROWER_LIGHTNING_URL', 'PASSBOOK_LENDER_LIGHTNING_URL'):
        env.pop(name, None)
    processes = []
    logs = []
    started = time.monotonic()
    print(json.dumps({'run': number, 'phase': 'seed', 'private_artifacts': str(directory)}), flush=True)
    try:
        with (directory / 'seed.log').open('w') as log:
            seed = subprocess.run(['npm', 'run', 'seed'], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        if seed.returncode:
            raise RuntimeError((directory / 'seed.log').read_text())
        state = json.loads((directory / 'state.json').read_text())
        seed_seconds = time.monotonic() - started

        def spawn(command, name, process_env):
            log = (directory / f'{name}.log').open('w')
            logs.append(log)
            process = subprocess.Popen(command, cwd=root, env=process_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(process)
            return process

        server = spawn(['npm', 'run', 'server'], 'server', env)
        for _ in range(200):
            if server.poll() is not None:
                raise RuntimeError((directory / 'server.log').read_text())
            try:
                with urllib.request.urlopen(env['PASSBOOK_URL'] + '/state', timeout=2) as response:
                    status = json.load(response)
                if status['platform_pk'] != state['platform_pk']:
                    raise ValueError('platform port belongs to another seed')
                break
            except OSError:
                time.sleep(.1)
        else:
            raise TimeoutError('platform did not become ready')
        peer_started = time.monotonic()
        lender_env = {**env, 'PASSBOOK_STATE': str(directory / 'intentionally-absent-private-state.json')}
        lender = spawn(['npm', 'run', 'peer', '--', '--role', 'lender', '--wallet', 'lender1',
            '--asset-id', state['asset']['id'], '--auto-approve', '--output', str(directory / 'lender-result.json')], 'lender', lender_env)
        for _ in range(200):
            if lender.poll() is not None:
                raise RuntimeError((directory / 'lender.log').read_text())
            if '"event":"offer_ready"' in (directory / 'lender.log').read_text():
                break
            time.sleep(.1)
        else:
            raise TimeoutError('lender offer did not become ready')
        borrower = spawn(['npm', 'run', 'peer', '--', '--role', 'borrower', '--lender-wallet', 'lender1',
            '--principal', '600', '--auto-approve', '--output', str(directory / 'borrower-result.json')], 'borrower', env)
        for name, process in [('borrower', borrower), ('lender', lender)]:
            if process.wait(timeout=300):
                raise RuntimeError((directory / f'{name}.log').read_text())
        borrower_result = json.loads((directory / 'borrower-result.json').read_text())
        lender_result = json.loads((directory / 'lender-result.json').read_text())
        assert borrower_result['pid'] != lender_result['pid'], 'the peers must be separate Node processes'
        assert borrower_result['actor_pk'] != lender_result['actor_pk'], 'the peers must use distinct keys'
        for field in ('loan_id', 'asset_id', 'disbursement_txid', 'repayment_txid', 'release_txid'):
            assert borrower_result[field] == lender_result[field], field
        txids = sorted({borrower_result[name] for name in ('lock_txid', 'disbursement_txid', 'repayment_txid', 'iou_return_txid', 'release_txid')})
        for txid in txids:
            assert rpc('getrawtransaction', [txid, True])['confirmations'] >= 1, txid
        doc = json.loads((directory / 'wallets' / 'borrower' / 'passbook.json').read_text())
        assert len(doc['pages']) == 1 and doc['pages'][0]['outcome'] == 'repaid'
        assert doc['pages'][0]['repayment']['kind'] == 'rgb_receipt'
        assert borrower_result['passbook']['ladder']['allowed_ltv_bps'] == 5500
        assert borrower_result['passbook']['assurance'] == ['signed_rgb_receipt']
        result = {'run': number, 'completed': True, 'seed_seconds': round(seed_seconds, 3),
            'peer_seconds': round(time.monotonic() - peer_started, 3),
            'lender_private_state_absent': True, 'artifacts': str(directory),
            'borrower': borrower_result, 'lender': lender_result, 'confirmed_txids': txids}
        results.append(result)
        print(json.dumps({'run': number, 'completed': True, 'peer_seconds': result['peer_seconds'],
            'borrower_pid': borrower_result['pid'], 'lender_pid': lender_result['pid']}), flush=True)
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=20)
        for log in logs:
            log.close()
        report_path.write_text(json.dumps({'evidence': 'Two separate Node peer processes on one host and real shared regtest; fresh wallets per run; rules sandbox and explicitly auto-approved rehearsal; no physical two-laptop or AI inference claim', 'runs': results}, indent=2) + '\n')

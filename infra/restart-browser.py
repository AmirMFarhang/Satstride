#!/usr/bin/env python3
"""Exercise saved-run controls in an already-ready isolated showcase."""
import argparse, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', required=True)
parser.add_argument('--report', required=True)
parser.add_argument('--screenshot', required=True)
args = parser.parse_args()
assert args.url.startswith('http://127.0.0.1:') and not args.url.startswith('http://127.0.0.1:4170'), 'Use your isolated dashboard'
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 1000})
    errors, console_errors, expected_switch_errors = [], [], []
    switching = False
    page.on('pageerror', lambda error: errors.append(str(error)))
    def console(message):
        if message.type != 'error': return
        item = {'text': message.text, 'url': message.location.get('url', '')}
        intentional_stream_close = switching and 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' in message.text and '/events?' in item['url']
        if switching and ('503 (Service Unavailable)' in message.text or intentional_stream_close): expected_switch_errors.append(item)
        else: console_errors.append(item)
    page.on('console', console)
    def snapshot(): return page.request.get(args.url + '/showcase/session').json()
    initial = snapshot()
    assert initial['phase'] == 'ready' and not initial['inspection'], initial
    run = initial['current']['id']
    saved = next(item['id'] for item in initial['runs'] if item['id'] != run)
    page.goto(args.url)
    page.get_by_role('button', name='New demo', exact=True).wait_for()
    assert page.get_by_role('button', name='New demo', exact=True).is_enabled()
    assert page.locator('#showcase-controls').is_visible()
    page.screenshot(path=args.screenshot, full_page=True)
    switching = True
    page.get_by_label('Saved demo run').select_option(saved)
    page.get_by_role('button', name='View saved run', exact=True).click()
    page.wait_for_function("async id => { const s=await fetch('/showcase/session').then(r=>r.json()); return s.phase==='ready' && s.current.id===id && s.inspection }", arg=saved, timeout=90000)
    page.wait_for_function("id => window.passbookDemoSession?.run===id && !document.body.hasAttribute('data-showcase-loading') && !!document.querySelector('#showcase-controls')", arg=saved, timeout=15000)
    current = snapshot()
    assert current['current']['id'] == saved and current['inspection']
    page.get_by_label('Saved demo run').select_option(run)
    page.get_by_role('button', name='Resume saved run', exact=True).click()
    page.wait_for_function("async id => { const s=await fetch('/showcase/session').then(r=>r.json()); return s.phase==='ready' && s.current.id===id && !s.inspection }", arg=run, timeout=90000)
    page.wait_for_function("id => window.passbookDemoSession?.run===id && !document.body.hasAttribute('data-showcase-loading') && !!document.querySelector('#showcase-controls')", arg=run, timeout=15000)
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(500)
    assert page.locator('#showcase-controls').is_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'horizontal overflow on mobile'
    assert page.get_by_role('button', name='New demo', exact=True).is_enabled()
    assert not errors, errors
    assert not console_errors, console_errors
    Path(args.report).write_text(json.dumps({'pass': True, 'checks': ['desktop session toolbar visible', 'View saved run selects read-only history', 'Resume saved run restores same run', 'mobile toolbar visible without horizontal overflow'], 'page_errors': errors, 'unexpected_console_errors': console_errors, 'expected_transition_network_errors': expected_switch_errors}, indent=2) + '\n')
    browser.close()

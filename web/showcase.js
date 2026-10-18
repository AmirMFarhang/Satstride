// Session controls belong to the local showcase supervisor, including when the
// business API is deliberately offline. No wallet or money action is replayed.
const style = document.createElement('style')
style.textContent = `
#showcase-controls{margin:12px 20px;padding:14px 18px;border:1px solid #cbd8cd;border-radius:12px;background:#f3f7ef;color:#193e32;font:13px/1.5 system-ui;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#showcase-controls strong{font-size:14px}#showcase-controls p{margin:2px 0;color:#52695b;font-size:12px}#showcase-controls button,#showcase-controls select{font:inherit;padding:8px 12px;border:1px solid #9eb6a3;border-radius:7px;color:#193e32;background:white;max-width:100%}
#showcase-controls button:first-of-type{background:#205d42;color:white;border-color:#205d42;font-weight:650}#showcase-controls button:disabled{opacity:.5;cursor:wait}#showcase-controls [role=status]{flex-basis:100%;font-size:12px}#showcase-controls button:focus-visible,#showcase-controls select:focus-visible{outline:3px solid #a27311;outline-offset:3px}
@media(max-width:600px){#showcase-controls{margin:10px;align-items:stretch}#showcase-controls>div{flex-basis:100%}#showcase-controls select{flex:1;width:150px}}
`
document.head.append(style)
const box = document.createElement('section')
box.id = 'showcase-controls'
box.setAttribute('aria-label', 'Demo sessions')
const info = document.createElement('div')
const title = document.createElement('strong'); title.textContent = 'Demo sessions'
const description = document.createElement('p'); description.textContent = 'Start again at step 1. Previous wallets and receipts are kept; their loans stay recorded.'
info.append(title, description)
const fresh = document.createElement('button'); fresh.type = 'button'; fresh.textContent = 'New demo'
const select = document.createElement('select'); select.setAttribute('aria-label', 'Saved demo run')
const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Resume saved run'
const inspect = document.createElement('button'); inspect.type = 'button'; inspect.textContent = 'View saved run'
const status = document.createElement('span'); status.setAttribute('role', 'status')
box.append(info, fresh, select, resume, inspect, status)
const notice = document.getElementById('demo-notice')
if (notice) notice.after(box); else document.body.prepend(box)
let snapshot, initialRun = window.passbookDemoSession?.run, initialGeneration = window.passbookDemoSession?.generation, sending = false, changed = false

function show(data) {
  snapshot = data
  if (!initialRun && data.current) initialRun = data.current.id
  if (!initialGeneration) initialGeneration = data.generation
  const previous = select.value
  select.replaceChildren(...data.runs.map(run => {
    const option = document.createElement('option'); option.value = run.id
    option.textContent = `${new Date(run.createdAt).toLocaleString()} · ${run.status}${run.id === data.current?.id ? ' · current' : ''}`
    return option
  }))
  select.value = [...select.options].some(o => o.value === previous) ? previous : data.current?.id ?? ''
  const busy = data.phase === 'starting' || data.phase === 'stopping' || data.changing || sending
  fresh.disabled = busy
  inspect.disabled = busy || !select.value
  resume.disabled = busy || !data.runs.find(run => run.id === select.value)?.can_resume
  status.textContent = data.error || (data.phase === 'starting' ? 'Preparing a new run. Seeding and model startup can take a few minutes…' : data.current ? `Run ${data.current.id} · ${data.current.status}` : 'No run selected')
  const loading = document.getElementById('showcase-loading')
  if (loading) loading.textContent = data.error || (data.phase === 'starting' ? 'Preparing wallets and local services…' : 'Saved run ready.')
  if (data.phase === 'ready' && (document.body.hasAttribute('data-showcase-loading') || (initialRun && (data.current?.id !== initialRun || data.generation !== initialGeneration)))) {
    if (!changed) { changed = true; location.replace('/') }
  }
}

async function refresh() {
  try {
    const response = await fetch('/showcase/session', { cache: 'no-store' })
    if (!response.ok) throw new Error('Session controls are unavailable')
    show(await response.json())
  } catch { status.textContent = 'Reconnecting to the demo supervisor…' }
}
async function replace(id, resumeRun = false) {
  if (sending || !snapshot) return
  sending = true; fresh.disabled = inspect.disabled = resume.disabled = true
  status.textContent = 'Saving this run and preparing the next one…'
  try {
    const response = await fetch('/showcase/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: snapshot.token, current: snapshot.current?.id, generation: snapshot.generation, ...(id ? resumeRun ? { resume: id } : { inspect: id } : {}) }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not change demo runs')
    location.assign('/')
  } catch (error) { sending = false; status.textContent = error.message; if (snapshot) show(snapshot) }
}
fresh.addEventListener('click', () => void replace())
inspect.addEventListener('click', () => void replace(select.value))
resume.addEventListener('click', () => void replace(select.value, true))
select.addEventListener('change', () => { if (snapshot) show(snapshot) })
await refresh()
setInterval(() => void refresh(), 1500)

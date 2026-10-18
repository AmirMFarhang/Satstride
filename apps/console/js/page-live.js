import { apiGet } from './api.js'
import { esc, relTime, absTime, short } from './format.js'
import { icon, chip, card, empty, skeletonCards } from './ui.js'
import { liveServices, liveTasks, liveWorkflows, WORKFLOW_STAGES } from './live-model.js'

let activity = []
let cursor = null
let storedWorkflowEndpoint = true

async function load(ctx, cache) {
  const results = await Promise.allSettled([
    apiGet('/overview'), apiGet('/market'), apiGet(cursor ? `/feed?after=${encodeURIComponent(cursor)}` : '/feed'),
    storedWorkflowEndpoint ? apiGet('/workflows').catch(error => {
      if (error.status === 404) storedWorkflowEndpoint = false
      throw error
    }) : Promise.resolve(null),
  ])
  const [overview, market, feed, workflows] = results
  // An unavailable platform must use the shell's stale-data/error state.
  if (overview.status === 'rejected') throw overview.reason
  const storedWorkflows = workflows.status === 'fulfilled' && workflows.value !== null
  if (feed.status === 'fulfilled') {
    const known = new Map(activity.map(item => [item.id, item]))
    for (const item of feed.value.items ?? []) known.set(item.id, item)
    activity = [...known.values()].sort((a, b) => b.at - a.at).slice(0, 100)
    cursor = feed.value.cursor ?? cursor
  }
  cache.data = {
    overview: overview.value,
    market: market.status === 'fulfilled' ? market.value : null,
    activity: [...activity],
    feedAvailable: feed.status === 'fulfilled',
    workflowNotes: storedWorkflows ? workflows.value.notes ?? [] : [...activity],
    workflowsAvailable: storedWorkflows || feed.status === 'fulfilled',
    workflowSource: storedWorkflows ? 'Stored agent updates' : 'Recent feed · limited history',
  }
}

function tasksCard(tasks, now) {
  return card({ title: 'Recorded tasks', iconName: 'list', sub: 'Open registry entries, obligations and recent negotiations',
    aside: tasks === null ? chip('Unavailable', 'warn') : chip(`${tasks.length} reported`, tasks.length ? 'brand' : 'neutral'),
    body: tasks === null
      ? empty('Task status unavailable', 'The market endpoint did not answer. An empty queue cannot be confirmed.', 'alert')
      : !tasks.length
        ? empty('No open tasks reported', 'The provider can be online while it waits for the next request. Private check progress is not exposed by this runtime.', 'check')
        : `<ol class="live-tasks">${tasks.map(task => `<li class="live-task" data-key="${esc(task.id)}">
            <span class="live-task-mark">${icon(task.state === 'attention' ? 'alert' : task.kind === 'loan' ? 'bank' : 'clock', 19)}</span>
            <div class="live-task-body"><strong>${esc(task.title)}</strong><p>${esc(task.detail)}</p>
              ${task.ref ? `<span class="mono small muted">${esc(short(task.ref, 10, 6))}</span>` : ''}
              ${task.at ? `<span class="small muted" data-tip="${esc(absTime(task.at))}"> · ${esc(relTime(task.at, now))}</span>` : ''}
            </div>${chip(task.state === 'observed' ? 'Observed' : task.state === 'attention' ? 'Needs attention' : 'Waiting', task.state === 'attention' ? 'warn' : 'neutral')}
          </li>`).join('')}</ol>`,
  })
}

function servicesCard(services) {
  return card({ title: 'Connected services', iconName: 'node', sub: 'Status read from the running provider',
    body: `<div class="live-services">${services.map(service => `<div class="live-service" data-key="${service.id}">
      <span class="dot dot-${service.tone}"></span><div><strong>${esc(service.name)}</strong><p>${esc(service.detail)}</p></div>${chip(service.status, service.tone)}
    </div>`).join('')}</div>`,
  })
}

function workflowCard(data, now) {
  const workflows = liveWorkflows(data.workflowNotes ?? data.activity, now)
  const available = data.workflowsAvailable ?? data.feedAvailable
  return card({ title: 'Live workflow', iconName: 'clock', sub: 'Last signed update from each agent',
    aside: chip(available ? data.workflowSource ?? 'Platform observations' : 'Updates unavailable', available ? 'brand' : 'warn'),
    body: workflows.length ? `<div class="live-workflows">${workflows.map(flow => `<article class="workflow-report" data-key="workflow-${esc(flow.actor)}">
      <div class="workflow-report-head"><strong>${esc(flow.role[0].toUpperCase() + flow.role.slice(1))} <span class="mono muted">${esc(short(flow.actor, 6, 4))}</span></strong>${chip(flow.stale || !available ? 'Stale · progress unknown' : flow.stopped ? 'Stopped' : 'Reported', flow.stale || !available || flow.stopped ? 'warn' : 'brand')}</div>
      <div class="workflow-stages" aria-label="Last reported stage: ${esc(flow.stage)}">${WORKFLOW_STAGES.map(([id, label]) => `<span class="workflow-stage${flow.stage === id ? ' is-current' : ''}">${esc(label)}</span>`).join('')}</div>
      <h4>${esc(flow.title)}</h4><p class="workflow-quote">“${esc(flow.note)}”</p>
      <p class="small muted">${esc(flow.detail)}</p><div class="workflow-source"><span>${esc(flow.source)}</span><time data-tip="${esc(absTime(flow.at))}">Last seen ${esc(relTime(flow.at, now))}</time></div>
    </article>`).join('')}</div>` : empty('No workflow stage reported', 'The recent feed contains no recognized signed agent stage. In-flight checks and phone consent screens remain unknown.', 'clock'),
  })
}

function activityCard(data, now) {
  return card({ title: 'Latest activity', iconName: 'feed', sub: data.feedAvailable ? 'Actual events observed by this platform' : 'Updates unavailable · showing the last received events',
    aside: '<a class="btn btn-sm btn-ghost" href="#/feed">Full feed</a>',
    body: data.activity.length ? `<ol class="live-activity">${data.activity.slice(0, 8).map(item => `<li data-key="${esc(item.id)}">
        <span class="live-activity-icon">${icon(item.source === 'nostr' ? 'relay' : 'check', 16)}</span>
        <div><strong>${esc(item.label || item.kind)}</strong><span class="small muted">${esc(item.source === 'nostr' ? 'Nostr' : item.source === 'platform' ? 'Platform' : 'Decision log')}</span></div>
        <time data-tip="${esc(absTime(item.at))}">${esc(relTime(item.at, now))}</time>
      </li>`).join('')}</ol>` : empty(data.feedAvailable ? 'Waiting for an event' : 'Activity unavailable', 'No sample events are inserted into this view.', 'feed'),
  })
}

export default {
  id: 'live', title: 'Live now', icon: 'clock', subtitle: 'Your provider, its services and the work it can actually observe.', interval: 5000, load,
  render(ctx) {
    const data = ctx.data
    if (!data) return `<div class="grid g-auto">${skeletonCards(3)}</div>`
    const overview = data.overview
    const tasks = liveTasks(data.market, ctx.now)
    const services = liveServices(overview)
    const ready = services.filter(service => service.tone === 'ok').length
    return `<section class="live-hero">
        <div><span class="live-eyebrow">SATSTRIDE · PROVIDER WORKSPACE</span><h2>Your provider,<br>at a glance.</h2>
          <p>Keep the demo in view. See connected services, reported work and the latest events as they arrive.</p>
          <div class="live-hero-actions"><a class="btn btn-primary" href="#/feed">${icon('feed', 16)} Open live feed</a><a class="btn" href="#/market">View market ${icon('arrow', 16)}</a></div>
        </div>
        <div class="live-summary"><img src="./brand.svg" alt="" width="52" height="52"><div class="live-summary-number">${ready}<span>/ ${services.length}</span></div>
          <strong>current service signals</strong><span class="small muted">Observed ${esc(relTime(overview.generated_at, ctx.now))}</span>
          <span class="small muted">${esc(overview.network?.label ?? 'Unknown network')} · test coins only</span>
        </div>
      </section>
      <div class="live-workspace"><div class="live-primary">${workflowCard(data, ctx.now)}${tasksCard(tasks, ctx.now)}</div>${servicesCard(services)}</div>
      ${activityCard(data, ctx.now)}
      <p class="live-source-note">${icon('info', 14)}Operator-only snapshots, refreshed every five seconds. Encrypted messages stay private; unreported progress stays unknown.</p>`
  },
}

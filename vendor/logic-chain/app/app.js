'use strict';
const $ = id => document.getElementById(id);
const MAX_REQUEST = 12000;
const FIELDS = [
  ['contradictions', 'Contradictions', true], ['unsupported_claims', 'Unsupported claims', true],
  ['new_logic', 'New logic'], ['improved_logic', 'Improved logic'], ['implementation_steps', 'Implementation steps'],
  ['test_cases', 'Proposed tests'], ['remaining_dependencies', 'Remaining dependencies'],
];
const RESUMABLE = ['interrupted', 'budget_exceeded'];
const BILLING = { per_token: 'charged per token', credits: 'credits per token', plan: 'plan limits', local: 'local', none: 'demo' };
const STATUS = { running: 'Running', complete: 'Complete', partial_failure: 'Finished with failures', failed: 'Failed', cancelled: 'Cancelled', budget_exceeded: 'Stopped at a limit', interrupted: 'Interrupted' };
const KINDS = [['ollama', 'Ollama / Ollama Cloud'], ['claude_cli', 'Claude membership'], ['codex_cli', 'ChatGPT membership'], ['github_models', 'GitHub Models'], ['openai', 'OpenAI API'], ['anthropic', 'Anthropic API'], ['gemini', 'Gemini API'], ['openai_compatible', 'OpenAI-compatible (xAI, others)'], ['demo', 'Demo fixture']];
const CLI_KINDS = ['claude_cli', 'codex_cli'];
const LIMITS = [['max_run_cents', 'Cost cap per run, in cents (0 is off)'], ['max_plan_calls', 'Plan calls per run (0 is off)'], ['timeout_seconds', 'Seconds per stage'], ['max_elapsed_seconds', 'Seconds per run'], ['max_output_tokens', 'Tokens per stage'], ['retries', 'Retries per stage'], ['max_context_chars', 'Context characters'], ['num_ctx', 'Ollama context size']];
const SUGGESTIONS = ['Design a rate limiter for a public REST API', 'Plan an offline-first notes app with sync', 'Define a testable software simulation of a dynamic container architecture'];

const state = { config: null, runs: [], run: null, tab: 'brief', selected: null, filter: 'all', query: '', stream: null };
const nodes = [];

function store(action) { try { return action(sessionStorage); } catch { return null; } }
let token = store(s => s.getItem('fraymusToken')) || '';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) el.setAttribute(key, value);
  }
  el.append(...children.filter(c => c !== null && c !== undefined));
  return el;
}

function toast(message, kind = 'info') {
  const el = h('div', { class: 'toast', dataset: { kind } }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3000);
}
const fail = error => toast(error.message || String(error), 'error');

function askToken() {
  return new Promise(resolve => {
    const dialog = $('tokenDialog');
    $('tokenInput').value = '';
    $('tokenSave').onclick = () => { dialog.close(); token = $('tokenInput').value; store(s => s.setItem('fraymusToken', token)); resolve(true); };
    dialog.showModal();
  });
}

async function send(path, opts = {}) {
  const headers = { ...opts.headers };
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(path, { ...opts, headers });
  if (response.status === 401) { await askToken(); return send(path, opts); }
  return response;
}

async function api(path, opts) {
  const response = await send(path, opts);
  const out = await response.json();
  if (!response.ok) throw new Error(out.error || `HTTP ${response.status}`);
  return out;
}
const post = (path, body) => api(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/* Formatting */
const pad = n => String(n).padStart(2, '0');
const clock = seconds => `${pad(Math.floor(seconds / 60))}:${pad(Math.floor(seconds % 60))}`;
const stages = () => state.run?.stages || [];
const ledgerSize = run => Object.values(run?.ledger || {}).reduce((sum, list) => sum + list.length, 0);
const isRunning = () => state.run?.status === 'running';
const stageAt = number => stages().find(s => s.number === number);
const slotFor = number => state.config?.slots?.[(number - 1) % 8];
function when(value) {
  const date = new Date(value), now = new Date();
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function elapsed() {
  const run = state.run;
  if (!run) return 0;
  if (run.summary?.elapsed_seconds !== undefined) return run.summary.elapsed_seconds;
  return run.created_at ? Math.max(0, (Date.now() - new Date(run.created_at)) / 1000) : 0;
}

/* Minimal Markdown to DOM; never uses innerHTML, so model output stays inert. */
function inline(text) {
  const out = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) out.append(h('strong', {}, token.slice(2, -2)));
    else if (token.startsWith('`')) out.append(h('code', {}, token.slice(1, -1)));
    else out.append(h('em', {}, token.slice(1, -1)));
    last = match.index + token.length;
  }
  out.append(text.slice(last));
  return out;
}
function markdown(source) {
  const root = h('div', { class: 'prose' });
  const lines = source.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) { root.append(h('h' + Math.min(heading[1].length, 3), {}, inline(heading[2]))); i++; continue; }
    if (line.startsWith('>')) {
      const quote = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, inline(quote.join(' '))));
      continue;
    }
    const list = line.match(/^\s*(\d+\.|[-*])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const el = h(ordered ? 'ol' : 'ul');
      for (; i < lines.length; i++) {
        const item = lines[i].match(/^\s*(?:\d+\.|[-*])\s+(.*)/);
        if (!item) break;
        el.append(h('li', {}, inline(item[1])));
      }
      root.append(el);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) { i++; continue; }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```|\s*(\d+\.|[-*])\s)/.test(lines[i]); i++) para.push(lines[i]);
    root.append(h('p', {}, inline(para.join(' '))));
  }
  return root;
}

/* Rendering */
function buildChain() {
  for (const pass of [1, 2]) {
    for (let i = 1; i <= 8; i++) {
      const number = (pass - 1) * 8 + i;
      const num = h('span', { class: 'num' }, pad(number)), role = h('span', { class: 'role' }), stat = h('span', { class: 'stat' });
      const el = h('button', { class: 'node', 'aria-pressed': 'false', onclick: () => selectStage(number) }, num, role, stat);
      nodes[number] = { el, role, stat };
      $('pass' + pass).append(el);
    }
  }
}

function renderChain() {
  for (let number = 1; number <= 16; number++) {
    const stage = stageAt(number), node = nodes[number];
    node.el.dataset.status = stage?.status || 'idle';
    node.el.setAttribute('aria-pressed', String(state.selected === number));
    node.role.textContent = stage?.name || slotFor(number)?.name || `Slot ${(number - 1) % 8 + 1}`;
    node.stat.textContent = stage?.status === 'complete' ? `+${stage.added ?? Object.values(stage.delta || {}).filter(Array.isArray).flat().length}` : stage?.status === 'failed' ? 'failed' : stage?.status === 'running' ? 'running' : '';
    node.el.title = `Stage ${number}: ${node.role.textContent}`;
  }
  const run = state.run, done = stages().filter(s => !['running'].includes(s.status)).length;
  const active = stages().find(s => s.status === 'running');
  const synthesis = run?.synthesis;
  $('progressBar').style.width = `${(done / 16) * 100}%`;
  $('headline').textContent = !run ? 'Ready' : active ? `Stage ${active.number} of 16` : run.review?.status === 'running' ? 'Reviewing warnings' : synthesis?.status === 'running' ? 'Writing the brief' : STATUS[run.status] || run.status;
  $('subline').textContent = !run ? 'Eight roles review your objective, then review each other.'
    : active ? `${active.name} is working${active.attempts > 1 ? `, attempt ${active.attempts}` : ''}`
    : run.status === 'failed' ? 'No stage returned usable output. Open a stage to see why.'
    : run.status === 'interrupted' ? 'The app stopped during this run. Resume picks up from where it stopped, and finished stages are kept.'
    : run.status === 'budget_exceeded' ? `${run.stop_reason || 'A limit was reached'}. Raise it in Providers, then resume to continue.`
    : isRunning() ? (run.review?.status === 'running' ? 'Independent providers are voting on the warnings' : 'Combining the ledger into one document')
    : `${run.summary?.stages_completed ?? stages().filter(s => s.status === 'complete').length} of 16 stages completed · ${ledgerSize(run)} ledger entries`;
  const brief = $('briefNode');
  brief.dataset.status = synthesis?.status || 'idle';
  $('briefNodeText').textContent = !synthesis ? (run && !isRunning() ? 'No brief for this run' : 'Written after the final stage')
    : synthesis.status === 'running' ? `${synthesis.name} is writing`
    : synthesis.status === 'complete' ? `Written by ${synthesis.name}`
    : synthesis.status === 'failed' ? 'Could not be written; the ledger is intact' : 'Cancelled';
}

function renderBrief() {
  const panel = $('briefPanel'), run = state.run;
  panel.replaceChildren();
  if (!run) return panel.append(h('p', { class: 'empty' }, 'Your brief appears here when a run finishes.'));
  const synthesis = run.synthesis;
  if (synthesis?.status === 'complete') {
    panel.append(h('p', { class: 'unverified' }, `Unverified proposal. Written by ${synthesis.name}${synthesis.model ? ` (${synthesis.model})` : ''} from the ledger. Nothing here has been built or tested.`), markdown(synthesis.text));
    return;
  }
  const message = isRunning() ? 'The brief is written once all sixteen stages finish.'
    : synthesis?.status === 'failed' ? `The brief failed: ${synthesis.error}. The full ledger is still available.`
    : ledgerSize(run) ? 'This run has no brief. See the Ledger tab for everything it produced.'
    : 'This run produced no output.';
  panel.append(h('p', { class: 'empty' }, message));
}

function renderLedger() {
  const run = state.run, query = state.query.toLowerCase();
  const filters = $('ledgerFilters');
  filters.replaceChildren(h('button', { type: 'button', 'aria-pressed': String(state.filter === 'all'), onclick: () => setFilter('all') }, 'All'));
  for (const [key, label] of FIELDS) {
    const count = run?.ledger?.[key]?.length || 0;
    if (count) filters.append(h('button', { type: 'button', 'aria-pressed': String(state.filter === key), onclick: () => setFilter(key) }, `${label} ${count}`));
  }
  const body = $('ledgerBody');
  body.replaceChildren();
  let shown = 0;
  for (const [key, label, warn] of FIELDS) {
    if (state.filter !== 'all' && state.filter !== key) continue;
    const records = (run?.ledger?.[key] || []).filter(r => !query || r.text.toLowerCase().includes(query));
    if (!records.length) continue;
    shown += records.length;
    body.append(h('div', { class: 'ledger-group', dataset: { warn: String(!!warn) } }, h('h3', { class: 'label' }, `${label} · ${records.length}`),
      ...records.map(r => h('div', { class: 'entry' }, h('span', {}, r.text), h('button', { type: 'button', title: 'Open the stage that added this', onclick: () => selectStage(r.stage) }, `S${pad(r.stage)} ${stageAt(r.stage)?.name || ''}`)))));
  }
  if (!shown) body.append(h('p', { class: 'empty' }, query ? 'No entries match.' : 'Ledger entries appear as stages complete.'));
  const dropped = Object.values(run?.dropped || {}).reduce((a, b) => a + b, 0);
  if (dropped) body.append(h('p', { class: 'unverified' }, `${dropped} non-warning entries were dropped at the ${250}-per-field limit. Warnings are never dropped.`));
}

const REASONS = { 'low-agreement': 'Reviewers disagreed', 'insufficient-members': 'Too few independent votes', 'all-abstain': 'No usable votes' };
function decisionRow(q) {
  const votes = Object.values(q.votes || {}), tally = {};
  for (const vote of votes) tally[vote] = (tally[vote] || 0) + 1;
  const summary = Object.entries(tally).map(([choice, count]) => `${count} ${choice}`).join(' · ') || 'no votes';
  return h('div', { class: 'decision' }, h('div', {}, q.text),
    h('div', { class: 'decision-meta' }, h('b', {}, q.reason ? REASONS[q.reason] || q.reason : q.answer === 'decide' ? 'Reviewers say this needs you' : q.answer), h('span', {}, `${summary} · ${Math.round(q.agreement * 100)}% agreement`),
      h('button', { type: 'button', title: 'Open the stage that raised this', onclick: () => selectStage(q.stage) }, `S${pad(q.stage)}`)));
}

function renderDecisions() {
  const panel = $('decisionsPanel'), review = state.run?.review;
  panel.replaceChildren();
  const questions = review?.questions || [];
  const pending = questions.filter(q => q.outcome === 'needs_you'), settled = questions.filter(q => q.outcome !== 'needs_you');
  $('decisionCount').textContent = pending.length;
  if (review?.status === 'running') return panel.append(h('p', { class: 'empty' }, `${review.members.length} independent providers are voting on the warnings: ${review.done ?? 0} of ${review.total ?? 0} calls finished.`));
  if (!questions.length) return panel.append(h('p', { class: 'empty' }, state.run && !isRunning() ? 'This run has no review.' : 'Warnings are reviewed after stage 16.'));
  panel.append(h('p', { class: 'unverified' }, `Votes show whether ${review.members.length} independent providers agree, not that anything is correct. A provider never votes on its own claim. ${questions.some(q => q.warnings?.includes('uncalibrated-members')) ? 'Not every voter has passed the benchmark.' : 'Every voter passed the benchmark, which measures a set of known answers, not these warnings.'}${review.omitted ? ` ${review.omitted} further warnings were not reviewed and remain in the Ledger.` : ''}`));
  for (const [who, error] of Object.entries(review.member_errors || {})) panel.append(h('p', { class: 'stage-error' }, `${who} could not vote: ${error}`));
  if (!pending.length) panel.append(h('p', { class: 'empty' }, 'Nothing needs your decision.'));
  const grouping = review.grouping;
  if (grouping?.status === 'running') panel.append(h('p', { class: 'empty' }, `${grouping.member} is grouping these warnings.`));
  if (grouping?.status === 'failed') panel.append(h('p', { class: 'stage-error' }, `These warnings could not be grouped: ${grouping.error}`));
  if (grouping?.status === 'complete') {
    const byId = Object.fromEntries(pending.map(q => [q.id, q]));
    panel.append(h('p', { class: 'count' }, `${grouping.groups.length} decisions covering ${pending.length} warnings. Grouped and rated by ${grouping.member}, so severity is one model's judgment.`));
    panel.append(...grouping.groups.map(group => h('details', { class: 'decision-group', ...(group.severity === 'high' ? { open: '' } : {}) },
      h('summary', {}, h('span', { class: 'severity', dataset: { level: group.severity } }, group.severity), h('span', {}, group.title), h('span', { class: 'tab-count' }, group.items.length)),
      group.why ? h('p', { class: 'group-why' }, group.why) : '', ...group.items.map(id => decisionRow(byId[id])))));
  } else panel.append(...pending.map(decisionRow));
  if (settled.length) panel.append(h('details', { class: 'resolved' }, h('summary', {}, `Settled by vote · ${settled.length}`), ...settled.map(decisionRow)));
}

function usageRows(rows) {
  return h('div', { class: 'bench-scroll' }, h('table', { class: 'bench-table' },
    h('thead', {}, h('tr', {}, ...['', 'Calls', 'Failed', 'Input', 'Output', 'Total'].map(label => h('th', {}, label)))),
    h('tbody', {}, ...rows.map(([label, row]) => h('tr', {}, h('td', {}, label), ...[row.calls, row.failed, row.input, row.output, row.total].map(value => h('td', {}, value.toLocaleString())))))));
}

function renderUsage() {
  const panel = $('usagePanel'), usage = state.run?.usage;
  panel.replaceChildren();
  if (!usage) return panel.append(h('p', { class: 'empty' }, state.run ? 'This run has no usage record. Runs started before usage tracking do not.' : 'Calls and tokens appear here during a run.'));
  const providers = Object.entries(usage.providers).filter(([, row]) => row.calls);
  const stat = (value, label) => h('div', { class: 'bench-stat' }, h('b', {}, value.toLocaleString()), h('small', {}, label));
  panel.append(h('div', { class: 'bench-stats' }, stat(usage.all.calls, 'model calls'), stat(usage.all.total, 'tokens'), stat(`$${(usage.all.usd ?? 0).toFixed(2)}`, 'estimated at list prices')));
  panel.append(h('p', { class: 'count' }, 'By step'), usageRows(Object.entries(usage.phases).filter(([, row]) => row.calls).map(([phase, row]) => [phase[0].toUpperCase() + phase.slice(1), row])));
  panel.append(h('p', { class: 'count' }, 'By provider'), usageRows(providers.map(([who, row]) => [`${who} (${BILLING[row.billing] || row.billing})`, row])));
  panel.append(h('p', { class: 'unverified' }, `Counts come from what providers reported.${usage.all.estimated_calls ? ` ${usage.all.estimated_calls} calls reported nothing, so their tokens are estimated.` : ''} Calls still running when a run was cancelled or the app stopped may be missing. Plan limits have no per-token price, but those tokens still count toward them. Dollars ignore cache discounts and leave out plan calls.${usage.all.unpriced_calls ? ` ${usage.all.unpriced_calls} calls used a model with no listed price, so they assume the highest listed rate.` : ''}`));
}

function setFilter(value) { state.filter = value; renderLedger(); }

function renderRoster(body) {
  const slots = state.config?.slots || [];
  body.append(h('div', { class: 'roster' }, ...slots.map((slot, i) => h('div', { class: 'roster-row' }, h('b', {}, pad(i + 1)), h('span', {}, slot.name), h('small', { title: slot.model }, slot.kind === 'demo' ? 'demo fixture' : slot.model)))));
}

function renderInspector() {
  const body = $('liveBody'), number = state.selected ?? (isRunning() ? stages().at(-1)?.number : null);
  body.replaceChildren();
  $('liveReset').hidden = !(state.selected && isRunning());
  $('liveTitle').textContent = number ? `Stage ${pad(number)}` : 'Roster';
  if (!number) return renderRoster(body);
  const stage = stageAt(number), slot = slotFor(number);
  if (!stage) {
    body.append(h('p', { class: 'stage-title' }, slot?.name || `Stage ${number}`), h('p', { class: 'stage-model' }, slot?.model || ''), h('p', { class: 'empty' }, 'This stage has not run.'));
    return;
  }
  const delta = stage.delta || {};
  body.append(h('p', { class: 'stage-title' }, stage.name), h('p', { class: 'stage-model' }, [stage.kind, stage.model].filter(Boolean).join(' · ')),
    h('div', { class: 'facts' },
      h('div', { class: 'fact' }, h('b', {}, stage.duration_seconds !== undefined ? `${stage.duration_seconds.toFixed(1)}s` : '…'), h('span', {}, 'Time')),
      h('div', { class: 'fact' }, h('b', {}, String(stage.attempts || 1)), h('span', {}, 'Attempts')),
      h('div', { class: 'fact' }, h('b', {}, stage.added !== undefined ? `+${stage.added}` : '—'), h('span', {}, 'Added'))));
  if (stage.error) body.append(h('div', { class: 'stage-error' }, stage.error));
  if (stage.status === 'running') body.append(h('p', { class: 'empty' }, 'Waiting for the model.'));
  const groups = h('div', { class: 'delta' });
  for (const [key, label] of FIELDS) if (delta[key]?.length) groups.append(h('h4', {}, label), h('ul', {}, ...delta[key].map(text => h('li', {}, text))));
  if (delta.notes) groups.append(h('h4', {}, 'Notes'), h('p', {}, delta.notes));
  body.append(groups);
  if (stage.raw) body.append(h('details', { class: 'raw', open: stage.status === 'failed' ? '' : null }, h('summary', {}, 'Raw output'), h('pre', {}, stage.raw)));
}

function renderRuns() {
  const root = $('runList');
  root.replaceChildren();
  if (!state.runs.length) return root.append(h('p', { class: 'rail-empty' }, 'No runs yet.'));
  for (const run of state.runs) {
    root.append(h('button', { class: 'run-item', 'aria-current': String(state.run?.id === run.id), title: run.request, onclick: () => openRun(run.id).catch(fail) },
      h('span', { class: 'dot', dataset: { status: run.status } }), h('span', { class: 'title' }, run.request), h('span', { class: 'meta' }, `${when(run.created_at)} · ${run.ledger_items} items`)));
  }
}

function renderComposer() {
  const config = state.config, running = isRunning(), text = $('request').value.trim();
  const remoteCount = config?.slots?.filter(s => s.remote).length || 0;
  $('runChain').disabled = running || !text || text.length > MAX_REQUEST || !config;
  $('runChain').hidden = running;
  $('cancelRun').hidden = !running;
  $('resumeRun').hidden = running || !RESUMABLE.includes(state.run?.status);
  $('request').readOnly = running;
  $('charCount').textContent = `${$('request').value.length.toLocaleString()} / ${MAX_REQUEST.toLocaleString()}`;
  $('charCount').dataset.over = String($('request').value.length > MAX_REQUEST);
  $('suggestions').hidden = !!$('request').value || !!state.run;
  $('modeChip').textContent = { demo: 'MOCK · demo fixtures', local: 'Local models', remote: 'Remote providers' }[config?.mode] || '';
  const notice = $('notice');
  notice.hidden = config?.mode !== 'demo';
  if (!notice.hidden) notice.replaceChildren(h('span', {}, 'MOCK mode: demo fixtures answer every stage, so no AI will read your objective and nothing here is model output. Install Ollama or add a provider for real results.'), h('button', { type: 'button', class: 'ghost small', onclick: openProviders }, 'Providers'));
  const consent = $('consent');
  consent.hidden = !remoteCount || running;
  if (remoteCount) {
    const calls = 16 * (1 + (config.retries ?? 1)) + (config.synthesize === false ? 0 : 1);
    const reviewing = config.review === false ? '' : ' The review adds about 20 more on a typical run, and more if the run raises more warnings.';
    $('consentText').textContent = config.allow_remote
      ? `Send this objective and the ledger to ${remoteCount} remote ${remoteCount === 1 ? 'slot' : 'slots'}. Up to ${calls} model calls, which may be billed.${reviewing}`
      : 'Remote providers are configured but not allowed. Enable them in Providers.';
    $('approveRemote').disabled = !config.allow_remote;
  }
}

function renderFooter() {
  const failed = stages().filter(s => s.status === 'failed').length;
  $('sbClock').textContent = clock(elapsed());
  $('sbStages').textContent = `${stages().filter(s => s.status === 'complete').length}/16`;
  $('sbLedger').textContent = ledgerSize(state.run);
  $('sbFailed').textContent = failed;
  $('sbRun').textContent = state.run?.id || 'none';
  $('sbMode').textContent = state.config?.mode || '…';
}

function renderActions() {
  const ready = !!state.run && !isRunning() && ledgerSize(state.run) > 0;
  for (const id of ['copyDoc', 'downloadDoc', 'exportSkill', 'verifyRun']) $(id).disabled = !ready;
  $('ledgerCount').textContent = ledgerSize(state.run);
}

function render() {
  renderChain(); renderComposer(); renderBrief(); renderDecisions(); renderUsage(); renderLedger(); renderInspector(); renderRuns(); renderActions(); renderFooter();
}

function setTab(tab) {
  state.tab = tab;
  $('tabBrief').setAttribute('aria-selected', String(tab === 'brief'));
  $('tabLedger').setAttribute('aria-selected', String(tab === 'ledger'));
  $('tabDecisions').setAttribute('aria-selected', String(tab === 'decisions'));
  $('tabUsage').setAttribute('aria-selected', String(tab === 'usage'));
  $('briefPanel').hidden = tab !== 'brief';
  $('decisionsPanel').hidden = tab !== 'decisions';
  $('usagePanel').hidden = tab !== 'usage';
  $('ledgerPanel').hidden = tab !== 'ledger';
}

function selectStage(number) {
  state.selected = number;
  $('live').dataset.open = 'true';
  renderChain(); renderInspector();
}

/* Run lifecycle */
async function follow(id) {
  state.stream?.abort();
  const control = state.stream = new AbortController();
  try {
    const response = await send(`/api/runs/${id}/events`, { signal: control.signal });
    if (!response.ok) throw new Error(`Live updates failed (HTTP ${response.status})`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue;
        state.run = JSON.parse(frame.slice(6));
        render();
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') fail(error);
  }
  if (state.stream === control) state.stream = null;
  if (state.run?.id === id && !control.signal.aborted) await finishRun();
}

async function finishRun() {
  await refreshRuns();
  const run = state.run;
  if (!run || isRunning()) return;
  if (run.synthesis?.status === 'complete') setTab('brief');
  else if (ledgerSize(run)) setTab('ledger');
  toast(`Run ${(STATUS[run.status] || run.status).toLowerCase()}`, run.status === 'failed' ? 'error' : 'info');
}

async function startRun() {
  const request = $('request').value.trim();
  if (!request || isRunning()) return;
  const { id } = await post('/api/run', { request, approve_remote: $('approveRemote').checked });
  $('approveRemote').checked = false;
  state.run = { id, request, status: 'running', created_at: new Date().toISOString(), stages: [], ledger: {}, summary: {} };
  state.selected = null;
  state.filter = 'all';
  location.hash = id;
  setTab('brief');
  render();
  await refreshRuns();
  await follow(id);
}

async function resumeRun() {
  const run = state.run;
  if (!RESUMABLE.includes(run?.status) || isRunning()) return;
  await post(`/api/runs/${run.id}/resume`, { approve_remote: $('approveRemote').checked });
  $('approveRemote').checked = false;
  state.run = { ...run, status: 'running' };
  render();
  await refreshRuns();
  await follow(run.id);
}

async function cancelRun() {
  if (!isRunning()) return;
  $('cancelRun').disabled = true;
  try { await post(`/api/runs/${state.run.id}/cancel`); }
  finally { $('cancelRun').disabled = false; }
}

async function openRun(id) {
  state.stream?.abort();
  const run = await api('/api/runs/' + id);
  state.run = run;
  state.selected = null;
  state.filter = 'all';
  $('request').value = run.request;
  location.hash = id;
  $('rail').dataset.open = 'false';
  setTab(run.synthesis?.status === 'complete' || !ledgerSize(run) ? 'brief' : 'ledger');
  render();
  if (run.status === 'running' && state.config?.active_run === id) follow(id);
}

function newRun() {
  if (isRunning()) return toast('A run is active. Cancel it to start another.');
  state.stream?.abort();
  state.run = null;
  state.selected = null;
  $('request').value = '';
  history.replaceState(null, '', location.pathname);
  setTab('brief');
  render();
  $('request').focus();
}

async function refreshRuns() { state.runs = await api('/api/runs'); renderRuns(); }

/* An open page must not go stale: it follows a run started elsewhere, and notices a restart or settings change. */
async function syncWithServer() {
  if (document.hidden || document.querySelector('dialog[open]')) return;
  const config = await api('/api/config');
  const settingsChanged = JSON.stringify(config.slots) !== JSON.stringify(state.config?.slots);
  state.config = config;
  if (settingsChanged) render();
  const active = config.active_run;
  const drafting = !state.run && $('request').value.trim();
  if (active && active !== state.run?.id && !drafting) { await openRun(active); await refreshRuns(); }
  else if (!active && isRunning() && !state.stream) { await openRun(state.run.id); await refreshRuns(); }
}

function confirmDelete(message) {
  return new Promise(resolve => {
    const dialog = $('confirm');
    $('confirmText').textContent = message;
    $('confirmYes').onclick = () => { dialog.close(); resolve(true); };
    $('confirmNo').onclick = () => { dialog.close(); resolve(false); };
    dialog.showModal();
  });
}

async function deleteCurrent() {
  if (!state.run || isRunning()) return;
  if (!await confirmDelete('Delete this run? Its saved file is removed permanently.')) return;
  await api('/api/runs/' + state.run.id, { method: 'DELETE' });
  newRun();
  await refreshRuns();
  toast('Run deleted');
}

/* Result actions */
async function documentText() {
  const response = await send(`/api/runs/${state.run.id}/document`);
  if (!response.ok) throw new Error('Could not build the document');
  return response.text();
}
function saveFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyDocument() { await navigator.clipboard.writeText(await documentText()); toast('Copied the document'); }
async function downloadDocument() { saveFile(`fraymus-${state.run.id}.md`, await documentText(), 'text/markdown'); }
async function exportSkill() {
  const manifest = await post('/api/export/' + state.run.id);
  saveFile(manifest.id + '.json', JSON.stringify(manifest, null, 2), 'application/json');
  toast(`Exported an unverified skill package to ${manifest.package}`);
}
async function verifyRun() {
  const result = await api('/api/runs/' + state.run.id + '/verify');
  toast(result.ok ? `Signed chain verified: ${result.records} records by ${result.signer}${result.mode === 'mock' ? ' (MOCK run)' : ''}` : `Verification failed: ${result.errors[0]}`);
}

/* Providers */
function slotRow(slot, index) {
  const name = h('input', { type: 'text', value: slot.name || '', 'aria-label': `Slot ${index + 1} name`, maxlength: 40 });
  const kind = h('select', { 'aria-label': `Slot ${index + 1} provider` }, ...KINDS.map(([value, label]) => h('option', { value }, label)));
  kind.value = slot.kind || 'demo';
  const model = h('input', { type: 'text', value: slot.model || '', list: 'ollamaModels', placeholder: 'Model (blank for default on memberships)', 'aria-label': `Slot ${index + 1} model` });
  const url = h('input', { type: 'text', value: slot.url || '', placeholder: 'Endpoint URL (blank for default)', 'aria-label': `Slot ${index + 1} URL` });
  const keyEnv = h('input', { type: 'text', value: slot.key_env || '', placeholder: 'KEY_VARIABLE_NAME', 'aria-label': `Slot ${index + 1} key variable` });
  const result = h('div', { class: 'slot-result' }, slot.key_env ? (slot.key_present ? `${slot.key_env} is set` : `${slot.key_env} is not set on the server`) : '');
  const extra = h('div', { class: 'slot-extra' }, url, keyEnv);
  const read = () => ({ ...slot, name: name.value, kind: kind.value, model: model.value, url: url.value, key_env: keyEnv.value });
  const syncKind = () => { const demo = kind.value === 'demo'; extra.hidden = demo || CLI_KINDS.includes(kind.value); model.disabled = demo; keyEnv.hidden = kind.value === 'ollama'; };
  kind.addEventListener('change', syncKind);
  syncKind();
  const test = h('button', { type: 'button', class: 'ghost small', onclick: async () => {
    result.textContent = 'Running a full-size stage, which can take a minute…'; result.dataset.ok = 'true';
    try {
      // Pressing Test is the approval for this one call.
      const out = await post('/api/test-slot', { slot: read(), approve_remote: true });
      result.dataset.ok = String(out.ok);
      result.textContent = out.ok ? `Full-size stage passed: ${out.items} findings in ${out.seconds}s` : out.error;
    } catch (error) { result.dataset.ok = 'false'; result.textContent = error.message; }
  } }, 'Test');
  const row = h('div', { class: 'slot' }, h('b', {}, pad(index + 1)), name, kind, model, test, extra, result);
  row.readSlot = read;
  row.setSlot = next => { name.value = next.name; kind.value = next.kind; model.value = next.model || ''; url.value = next.url || ''; keyEnv.value = next.key_env || ''; slot.focus = next.focus; result.textContent = ''; syncKind(); };
  return row;
}

async function openProviders() {
  const config = await api('/api/config');
  state.config = config;
  $('slotRows').replaceChildren(...config.slots.map(slotRow));
  $('limitFields').replaceChildren(...LIMITS.map(([key, label]) => h('label', {}, label, h('input', { type: 'number', id: 'limit-' + key, value: config[key] ?? '', step: 1 }))));
  $('synthesize').checked = config.synthesize !== false;
  $('review').checked = config.review !== false;
  $('allowRemote').checked = !!config.allow_remote;
  $('providersError').hidden = true;
  const { models } = await api('/api/ollama/models');
  $('ollamaModels').replaceChildren(...models.map(value => h('option', { value })));
  $('useRecommended').onclick = async () => {
    try {
      const mix = await api('/api/recommended');
      [...$('slotRows').children].forEach((row, i) => row.setSlot(mix.slots[i]));
      for (const key of ['timeout_seconds', 'max_output_tokens', 'max_context_chars']) $('limit-' + key).value = mix[key];
      $('allowRemote').checked = mix.allow_remote;
      toast('Recommended mix loaded. Save to keep it.');
    } catch (error) { fail(error); }
  };
  $('connections').replaceChildren(h('p', { class: 'count' }, 'Checking connections…'));
  $('providers').showModal();
  const connections = await api('/api/connections');
  $('connections').replaceChildren(...connections.map(c => h('div', { class: 'connection' }, h('span', { class: 'dot', dataset: { ready: String(c.ready) } }), h('span', {}, c.name), h('small', {}, c.detail))));
}

async function saveProviders() {
  const limits = Object.fromEntries(LIMITS.map(([key]) => [key, Number($('limit-' + key).value)]));
  const body = { slots: [...$('slotRows').children].map(row => row.readSlot()), ...limits, passes: 2, synthesize: $('synthesize').checked, review: $('review').checked, allow_remote: $('allowRemote').checked };
  try {
    await post('/api/config', body);
    state.config = await api('/api/config');
    $('providers').close();
    render();
    toast('Providers saved');
  } catch (error) {
    $('providersError').textContent = error.message;
    $('providersError').hidden = false;
  }
}

/* Benchmark */
let benchTimer = null;
const percent = value => value == null ? '–' : `${Math.round(value * 100)}%`;
function benchStat(value, text) { return h('div', { class: 'bench-stat' }, h('b', {}, value), h('small', {}, text)); }

function renderBenchmark({ running, error, report }) {
  const body = $('benchmarkBody'), remote = state.config?.slots?.filter(s => s.remote).length || 0;
  $('runBenchmark').hidden = running;
  $('cancelBenchmark').hidden = !running;
  $('benchConsent').hidden = !remote || running;
  $('runBenchmark').disabled = !!remote && !$('benchApprove').checked;
  const slots = new Set((state.config?.slots || []).map(s => `${s.kind}:${s.model || 'default'}`)).size;
  $('benchConsentText').textContent = state.config?.allow_remote ? `Send 8 test scenarios to ${slots} providers. 8 calls each, ${slots * 8} in total, which may be billed.` : 'Remote providers are configured but not allowed. Enable them in Providers.';
  $('benchApprove').disabled = !state.config?.allow_remote;
  body.replaceChildren();
  if (error) body.append(h('p', { class: 'stage-error' }, error));
  if (running) return body.append(h('p', { class: 'empty' }, report ? `Asking providers: ${report.done} of ${report.total} calls finished.` : 'Starting…'));
  if (!report) return body.append(h('p', { class: 'empty' }, 'No benchmark yet. Run one to see whether your reviewers tell real issues from settled ones and noise.'));
  const panel = report.panel, members = Object.entries(report.members).sort((a, b) => b[1].accuracy - a[1].accuracy);
  body.append(
    h('p', { class: 'unverified' }, `${report.corpus.cases} warnings in ${report.corpus.scenarios} scenarios, written by one author. Each score is how often a provider was right about whether a warning needs a person. Clearing everything would score ${percent(report.baseline)} and miss every real issue. Scores describe this set, not any single vote.`),
    h('div', { class: 'label sheet-label' }, 'Review panel'),
    h('div', { class: 'bench-stats' },
      benchStat(`${panel.wrongly_dismissed} of ${panel.real_issues}`, 'real issues wrongly dismissed'),
      benchStat(`${panel.over_sent} of ${panel.non_issues}`, 'non-issues sent to you anyway'),
      benchStat(`${panel.right} of ${panel.answered}`, 'right when the panel agreed')),
    h('p', { class: 'count' }, `Review seats: ${panel.members.join(', ')}`),
    h('div', { class: 'label sheet-label' }, 'Providers'),
    h('div', { class: 'bench-scroll' }, h('table', { class: 'bench-table' },
      h('thead', {}, h('tr', {}, ...['Provider', 'Score', '95% range', 'Real found', 'Cleared', 'Answered', 'Standing'].map(name => h('th', {}, name)))),
      h('tbody', {}, ...members.map(([who, m]) => h('tr', { title: who },
        h('td', {}, who), h('td', {}, percent(m.accuracy)), h('td', {}, `${percent(m.low)}–${percent(m.high)}`), h('td', {}, percent(m.found)), h('td', {}, percent(m.cleared)), h('td', {}, `${m.answered}/${m.cases}`), h('td', { dataset: { standing: m.standing } }, m.standing)))))));
  for (const [who, m] of members) for (const [scenario, message] of Object.entries(m.errors)) body.append(h('p', { class: 'stage-error' }, `${who} failed ${scenario}: ${message}`));
  if (report.missed.length) body.append(h('div', { class: 'label sheet-label' }, 'Most contested answers'),
    ...report.missed.slice(0, 12).map(m => h('div', { class: 'decision' }, h('div', {}, m.text),
      h('div', { class: 'decision-meta' }, h('b', {}, `Answer: ${m.label}`), h('span', {}, `${m.wrong} of ${members.length} differed · ${m.why}`)))));
}

async function refreshBenchmark() {
  const status = await api('/api/benchmark');
  renderBenchmark(status);
  clearTimeout(benchTimer);
  if (status.running && $('benchmark').open) benchTimer = setTimeout(() => refreshBenchmark().catch(fail), 2000);
}
async function openBenchmark() {
  state.config = await api('/api/config');
  $('benchApprove').checked = false;
  $('benchmark').showModal();
  await refreshBenchmark();
}
async function startBenchmark() {
  await post('/api/benchmark', { approve_remote: $('benchApprove').checked });
  await refreshBenchmark();
}

/* Quality */
let qualityTimer = null;
const range = score => score.low === score.high ? `${score.low} of ${score.items}` : `${score.low}–${score.high} of ${score.items}`;

function renderQuality({ running, error, report, criteria, current_hash }) {
  const body = $('qualityBody'), remote = state.config?.slots?.filter(s => s.remote).length || 0;
  $('runQuality').hidden = running;
  $('cancelQuality').hidden = !running;
  $('qualityConsent').hidden = !remote || running;
  $('runQuality').disabled = !!remote && !$('qualityApprove').checked;
  $('qualityConsentText').textContent = state.config?.allow_remote ? 'Send test documents and your newest matching briefs and ledgers to up to 4 providers. About 1,100 calls and $2.20, which may be billed.' : 'Remote providers are configured but not allowed. Enable them in Providers.';
  $('qualityApprove').disabled = !state.config?.allow_remote;
  body.replaceChildren();
  if (error) body.append(h('p', { class: 'stage-error' }, error));
  if (running) return body.append(h('p', { class: 'empty' }, report ? `Checking: ${report.done} of ${report.total} steps finished.` : 'Starting…'));
  if (!report) return body.append(h('p', { class: 'empty' }, 'No quality test yet. It needs a finished run of one of the four test objectives listed in docs/QUALITY.md.'));
  const judges = Object.entries(report.judges).sort((a, b) => b[1].accuracy - a[1].accuracy), used = report.usage?.all;
  body.append(h('p', { class: 'unverified' }, 'Coverage of a checklist written by one author from the objective alone. It shows what a plan decided, not whether those decisions are right. A range means the judges split on some items. Traced means the ledger proposed a claim, not that it is true. Fakes are hidden among the claims of each brief to show the check is working.'));
  if (report.cases_hash !== current_hash) body.append(h('p', { class: 'stage-error' }, 'These scores used an older checklist or prompt, so they do not compare with a new test.'));
  if (report.status === 'no_judges') body.append(h('p', { class: 'stage-error' }, 'Fewer than two judges passed, so nothing was scored.'));
  if (report.status === 'budget_exceeded') body.append(h('p', { class: 'stage-error' }, report.stop_reason));
  if (report.runs.length) body.append(h('div', { class: 'label sheet-label' }, 'Runs'), h('div', { class: 'bench-scroll' }, h('table', { class: 'bench-table' },
    h('thead', {}, h('tr', {}, ...['Objective', 'Ledger', 'Brief', 'Dropped by brief', 'Traced to ledger', 'Fakes caught'].map(name => h('th', {}, name)))),
    h('tbody', {}, ...report.runs.map(run => h('tr', { title: run.request },
      h('td', {}, run.case), h('td', {}, range(run.ledger)), h('td', {}, range(run.brief)), h('td', {}, String(run.lost.length)), h('td', {}, run.claims ? `${run.claims.supported} of ${run.claims.claims}` : '–'), h('td', {}, run.claims ? `${run.claims.planted_caught} of ${run.claims.planted}` : '–')))))));
  for (const run of report.runs) if (run.lost.length) body.append(h('div', { class: 'label sheet-label' }, `In the ledger, missing from the ${run.case} brief`),
    ...run.lost.map(id => h('div', { class: 'decision' }, h('div', {}, criteria[id] || id))));
  for (const run of report.runs) if (run.claims?.unsupported_claims.length || run.claims?.new_terms.length) body.append(h('div', { class: 'label sheet-label' }, `Not traced to the ledger in the ${run.case} brief`),
    ...run.claims.unsupported_claims.map(text => h('div', { class: 'decision' }, h('div', {}, text))),
    ...(run.claims.new_terms.length ? [h('p', { class: 'count' }, `Numbers and names the ledger never uses: ${run.claims.new_terms.join(', ')}`)] : []));
  body.append(h('div', { class: 'label sheet-label' }, 'Judges'), h('div', { class: 'bench-scroll' }, h('table', { class: 'bench-table' },
    h('thead', {}, h('tr', {}, ...['Provider', 'Score', 'Met found', 'Wrongly passed', 'Standing'].map(name => h('th', {}, name)))),
    h('tbody', {}, ...judges.map(([who, j]) => h('tr', { title: who },
      h('td', {}, who), h('td', {}, percent(j.accuracy)), h('td', {}, percent(j.found)), h('td', {}, percent(j.false_met)), h('td', { dataset: { standing: j.standing } }, j.standing)))))));
  if (used) body.append(h('p', { class: 'count' }, `${used.calls} calls, ${used.total.toLocaleString()} tokens, about $${used.usd.toFixed(2)} at list prices.`));
}

async function refreshQuality() {
  const status = await api('/api/quality');
  renderQuality(status);
  clearTimeout(qualityTimer);
  if (status.running && $('quality').open) qualityTimer = setTimeout(() => refreshQuality().catch(fail), 2000);
}
async function openQuality() {
  state.config = await api('/api/config');
  $('qualityApprove').checked = false;
  $('quality').showModal();
  await refreshQuality();
}
async function startQuality() {
  await post('/api/quality', { approve_remote: $('qualityApprove').checked });
  await refreshQuality();
}

/* Command palette */
let paletteItems = [], paletteIndex = 0;
function commands() {
  const ready = !$('exportSkill').disabled;
  const items = [
    { label: 'New run', hint: 'N', run: newRun },
    { label: 'Run chain', hint: '⌘↵', show: !$('runChain').disabled, run: () => startRun().catch(fail) },
    { label: 'Cancel run', show: isRunning(), run: () => cancelRun().catch(fail) },
    { label: 'Resume run', show: !isRunning() && RESUMABLE.includes(state.run?.status), run: () => resumeRun().catch(fail) },
    { label: 'Open providers', run: () => openProviders().catch(fail) },
    { label: 'Open benchmark', run: () => openBenchmark().catch(fail) },
    { label: 'Open quality test', run: () => openQuality().catch(fail) },
    { label: 'Show brief', show: !!state.run, run: () => setTab('brief') },
    { label: 'Show ledger', show: !!state.run, run: () => setTab('ledger') },
    { label: 'Show decisions', show: !!state.run, run: () => setTab('decisions') },
    { label: 'Show usage', show: !!state.run, run: () => setTab('usage') },
    { label: 'Copy document', show: ready, run: () => copyDocument().catch(fail) },
    { label: 'Download document', show: ready, run: () => downloadDocument().catch(fail) },
    { label: 'Export candidate skill', show: ready, run: () => exportSkill().catch(fail) },
    { label: 'Verify signatures', show: ready, run: () => verifyRun().catch(fail) },
    { label: 'Delete this run', show: !!state.run && !isRunning(), run: () => deleteCurrent().catch(fail) },
  ].filter(item => item.show !== false);
  return items.concat(state.runs.map(run => ({ label: run.request, hint: when(run.created_at), run: () => openRun(run.id).catch(fail) })));
}
function renderPalette() {
  const query = $('paletteInput').value.toLowerCase();
  paletteItems = commands().filter(item => item.label.toLowerCase().includes(query));
  paletteIndex = Math.min(paletteIndex, Math.max(paletteItems.length - 1, 0));
  $('paletteList').replaceChildren(...paletteItems.map((item, i) => h('button', { class: 'palette-item', role: 'option', 'aria-selected': String(i === paletteIndex), onclick: () => choosePalette(i) }, h('span', {}, item.label), h('span', {}, item.hint || ''))));
  $('paletteList').children[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}
function choosePalette(index) { const item = paletteItems[index]; $('palette').close(); item?.run(); }
function openPalette() { $('paletteInput').value = ''; paletteIndex = 0; renderPalette(); $('palette').showModal(); $('paletteInput').focus(); }

/* Wiring */
function bind() {
  $('runChain').onclick = () => startRun().catch(fail);
  $('resumeRun').onclick = () => resumeRun().catch(fail);
  $('cancelRun').onclick = () => cancelRun().catch(fail);
  $('newRun').onclick = newRun;
  $('openProviders').onclick = () => openProviders().catch(fail);
  $('closeProviders').onclick = () => $('providers').close();
  $('saveProviders').onclick = saveProviders;
  $('openBenchmark').onclick = () => openBenchmark().catch(fail);
  $('openQuality').onclick = () => openQuality().catch(fail);
  $('closeQuality').onclick = () => $('quality').close();
  $('runQuality').onclick = () => startQuality().catch(fail);
  $('cancelQuality').onclick = () => post('/api/quality/cancel', {}).then(refreshQuality).catch(fail);
  $('qualityApprove').addEventListener('change', () => { $('runQuality').disabled = !$('qualityApprove').checked; });
  $('closeBenchmark').onclick = () => $('benchmark').close();
  $('runBenchmark').onclick = () => startBenchmark().catch(fail);
  $('cancelBenchmark').onclick = () => post('/api/benchmark/cancel', {}).then(refreshBenchmark).catch(fail);
  $('benchApprove').addEventListener('change', () => { $('runBenchmark').disabled = !$('benchApprove').checked; });
  $('openPalette').onclick = openPalette;
  $('tabBrief').onclick = () => setTab('brief');
  $('tabLedger').onclick = () => setTab('ledger');
  $('tabDecisions').onclick = () => setTab('decisions');
  $('tabUsage').onclick = () => setTab('usage');
  $('copyDoc').onclick = () => copyDocument().catch(fail);
  $('downloadDoc').onclick = () => downloadDocument().catch(fail);
  $('exportSkill').onclick = () => exportSkill().catch(fail);
  $('verifyRun').onclick = () => verifyRun().catch(fail);
  $('liveReset').onclick = () => { state.selected = null; renderChain(); renderInspector(); };
  $('briefNode').onclick = () => setTab('brief');
  $('toggleRail').onclick = () => { $('rail').dataset.open = String($('rail').dataset.open !== 'true'); };
  $('toggleLive').onclick = () => { $('live').dataset.open = String($('live').dataset.open !== 'true'); };
  $('request').addEventListener('input', renderComposer);
  $('ledgerSearch').addEventListener('input', event => { state.query = event.target.value; renderLedger(); });
  $('paletteInput').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  $('paletteInput').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { paletteIndex = Math.min(paletteIndex + 1, paletteItems.length - 1); renderPalette(); event.preventDefault(); }
    if (event.key === 'ArrowUp') { paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); event.preventDefault(); }
    if (event.key === 'Enter') { choosePalette(paletteIndex); event.preventDefault(); }
  });
  for (const id of ['palette', 'providers', 'benchmark', 'quality']) $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });
  document.addEventListener('keydown', event => {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'k') { event.preventDefault(); $('palette').open ? $('palette').close() : openPalette(); }
    if (command && event.key === 'Enter' && !$('runChain').disabled) { event.preventDefault(); startRun().catch(fail); }
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]');
    if (!typing && !command && event.key.toLowerCase() === 'n') { event.preventDefault(); newRun(); }
  });
  $('suggestions').replaceChildren(...SUGGESTIONS.map(text => h('button', { type: 'button', onclick: () => { $('request').value = text; renderComposer(); $('request').focus(); } }, text)));
  setInterval(() => { if (isRunning()) renderFooter(); }, 1000);
  setInterval(() => syncWithServer().catch(() => {}), 4000);
}

async function init() {
  buildChain();
  bind();
  render();
  try {
    state.config = await api('/api/config');
    await refreshRuns();
    const id = state.config.active_run || location.hash.slice(1);
    if (id && /^[a-f0-9]{16}$/.test(id)) await openRun(id).catch(() => history.replaceState(null, '', location.pathname));
    render();
    if (!state.run) $('request').focus();
  } catch (error) { fail(error); }
}
init();

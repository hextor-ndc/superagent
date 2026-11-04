/**
 * Point 3: the pages drawn inside t3code. Each is one self-contained page (no script or style from elsewhere) that serves
 * up to two hosts:
 * - as an MCP App, which t3code renders in the console thread in place of the tool call. It talks to t3code over the MCP
 *   Apps postMessage protocol (`ui/initialize`, `tools/call`, `ui/notifications/tool-result`, the host's theme) and calls
 *   the console tools;
 * - as the plain panel at `/panel/<token>`, for t3code's browser tab, where it uses this service's HTTP API
 *   (`POST <api>/action`, src/http/server.ts).
 *
 * The attention page (`ui://superagent/attention`, and the panel): the "needs a person" queue. A worker thread that waits in
 * t3code shows its approvals with a link to approve them in T3 Code (nothing here can grant one), and its questions with
 * their options and an Answer button. Below them, "To review / merge" lists finished tickets of projects without pull
 * requests whose branch is not merged yet, with the commands that clean up after them. On the panel, a "New project" form
 * follows the queue.
 *
 * The New project page (`ui://superagent/new-project`, which `superagent_new_project_form` draws in the console thread): the
 * same form on its own. It runs `superagent_new_project` with what the operator enters: a group (a top-level folder
 * `superagent_new_project_options` offers), a repo name, a purpose, and optionally a title, notes and a first request. No
 * model chooses anything: the call goes from the page to the tool. The form is filled once and never drawn again, so the
 * panel's refresh of the queue leaves what is typed alone.
 */
import { NAME_RULE, PART_WAY, SEGMENT } from '../app/folder-name.ts'

export const ATTENTION_URI = 'ui://superagent/attention'
export const NEW_PROJECT_URI = 'ui://superagent/new-project'
export const MCP_APP_MIME = 'text/html;profile=mcp-app'
const PROTOCOL = '2026-01-26'
type Mode = 'app' | 'panel'

/** The look every page shares: colours as variables for light and dark (the host's theme wins over the system's), type, rows and buttons. */
const STYLE = `:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e8;--chip:#f2f2f5;--accent:#2f6fde;--warn:#b25a00;--bad:#c0362c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#17171a;--fg:#ececf0;--muted:#9a9aa3;--line:#2c2c31;--chip:#232328;--accent:#6ea0ff;--warn:#f0a35c;--bad:#ff7a6e}}
:root[data-theme=dark]{--bg:#17171a;--fg:#ececf0;--muted:#9a9aa3;--line:#2c2c31;--chip:#232328;--accent:#6ea0ff;--warn:#f0a35c;--bad:#ff7a6e}
body{margin:0;padding:12px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:15px;margin:0 0 10px}.empty{color:var(--muted);padding:8px 0}
.row{border-top:1px solid var(--line);padding:10px 0}.row:first-of-type{border-top:0}
.top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.id{color:var(--muted);font-variant-numeric:tabular-nums}
.stage{background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px}.stage.answer,.stage.review{color:var(--accent)}
.stage.blocked,.stage.approve{color:var(--warn)}.stage.failed,.stage.delivery{color:var(--bad)}.stage.question{color:var(--accent)}
.approval{margin:6px 0 0;padding:4px 8px;border-left:3px solid var(--warn);background:var(--chip);border-radius:4px;white-space:pre-wrap}
.pq{margin:8px 0 0}.pq .h{color:var(--muted);font-size:12px}.opts{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 0;padding:0;list-style:none}
.opts li{display:flex;flex-direction:column}.opts .d{color:var(--muted);font-size:12px}a.btn.primary{border-color:var(--warn);color:var(--warn)}
.q{margin:6px 0 0}.s{margin:4px 0 0;color:var(--muted);white-space:pre-wrap}
.actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
button,a.btn{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer;text-decoration:none}
textarea{width:100%;box-sizing:border-box;margin-top:6px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px}
.note{color:var(--muted);font-size:12px;margin-top:10px}
h2{font-size:13px;margin:16px 0 4px;color:var(--muted)}code{display:block;font-size:12px;color:var(--muted);white-space:pre-wrap;word-break:break-all;margin:2px 0 0}`

/**
 * The New project form's own look, in the same variables. Its one column may shrink below its longest word (the workspace's
 * path), which wraps, so the form fits a 390 px wide window without scrolling sideways.
 */
const FORM_STYLE = `[hidden]{display:none!important}.sec{margin-top:22px;padding-top:12px;border-top:1px solid var(--line)}
form.np{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;max-width:560px;overflow-wrap:anywhere}form.np label{display:flex;flex-direction:column;gap:3px}.h{color:var(--muted);font-size:12px}
input,select{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 6px;min-width:0}
form.np textarea{margin-top:0}.bad{color:var(--bad);font-size:12px;margin:0}.np p{margin:0}
button.primary{border-color:var(--accent);color:var(--accent)}button:disabled{opacity:.6;cursor:default}
.res{margin-top:12px;padding:8px 10px;border-left:3px solid var(--accent);background:var(--chip);border-radius:4px;overflow-wrap:anywhere;max-width:560px}
.res p{margin:0 0 4px}.res ul{margin:4px 0;padding-left:18px}.res.refused{border-color:var(--bad)}.res.partway,.res .warn{border-color:var(--warn);color:var(--warn)}`

/**
 * The start of every page's script: the mode and API, `esc` for every value put into HTML, `$`, the MCP Apps requests
 * (`rpc`, `notify`), and `call`, which runs a console tool by `tools/call` in an MCP App and by `POST <api>/action` on the
 * panel. An error the tool itself gave (a refusal, or a failure it reports) is marked `fromTool`, apart from one where no
 * answer came back.
 */
const baseScript = (mode: Mode, apiBase: string) => `const MODE=${JSON.stringify(mode)},API=${JSON.stringify(apiBase)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=id=>document.getElementById(id);
let seq=0;const waiting=new Map();
function rpc(method,params){if(MODE!=='app')return Promise.reject(new Error('not an app'));const id=++seq;
  parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((ok,no)=>waiting.set(id,{ok,no}))}
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
const toolError=text=>Object.assign(new Error(text),{fromTool:true});
async function call(name,args){
  if(MODE==='app'){const r=await rpc('tools/call',{name,arguments:args});if(r&&r.isError)throw toolError((r.content||[]).map(c=>c.text).join(' '));return r&&r.structuredContent}
  const r=await fetch(API+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});
  if(!r.ok){const text=await r.text();let said=text;try{said=JSON.parse(text).error||text}catch(e){}throw r.status===400?toolError(said):new Error(said)}
  return r.json()}
`

/**
 * The end of every page's script. In an MCP App it answers the host's replies (an error the host itself gave is marked
 * `fromHost`), applies its theme, hands a tool result to the page's `toolResult`, and initializes, then calls the page's
 * `started`; on the panel it calls `started` at once. A failure goes to the page's `trouble`.
 *
 * T3 Code draws an MCP App in a frame 320 px high until the App sends `ui/notifications/size-changed` (it keeps the height
 * between 80 and 2000 px), so an App gives the body's height once it has initialized, and again whenever the body's size
 * changes, each height once and in whole pixels. The body's height does not follow the frame's, so this cannot loop.
 */
const startScript = (app: string) => `if(MODE==='app'){
  let sentHeight=0;
  const sendSize=()=>{const h=Math.ceil(document.body.getBoundingClientRect().height);if(h>0&&h!==sentHeight){sentHeight=h;notify('ui/notifications/size-changed',{height:h})}};
  window.addEventListener('message',e=>{const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
    if(m.id!==undefined&&waiting.has(m.id)){const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.no(Object.assign(new Error(m.error.message),{fromHost:true})):w.ok(m.result);return}
    if(m.method==='ui/notifications/tool-result')toolResult(m.params);
    if(m.method==='ui/notifications/host-context-changed'&&m.params&&m.params.theme)document.documentElement.dataset.theme=m.params.theme});
  rpc('ui/initialize',{protocolVersion:${JSON.stringify(PROTOCOL)},appInfo:{name:${JSON.stringify(app)},version:'0.1.0'},appCapabilities:{}})
    .then(r=>{const t=r&&r.hostContext&&r.hostContext.theme;if(t)document.documentElement.dataset.theme=t;notify('ui/notifications/initialized',{});
      sendSize();if(typeof ResizeObserver==='function')new ResizeObserver(sendSize).observe(document.body);return started()})
    .catch(e=>trouble(e.message));
}else started()
`

/** One page: the shared look and script around a page's own body, style and script. */
const page = (options: { title: string; style?: string; body: string; script: string; mode: Mode; apiBase: string; app: string }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<style>
${STYLE}${options.style ? `\n${options.style}` : ''}
</style></head><body>
${options.body}
<script>
${baseScript(options.mode, options.apiBase)}${options.script}${startScript(options.app)}</script></body></html>`

/** The New project form: hidden until `superagent_new_project_options` fills it, with `np-off` saying why in its place. */
const formHtml = (sectionClass: string) => `<section${sectionClass ? ` class="${sectionClass}"` : ''} id="np"><h1>New project</h1><p class="empty" id="np-off">Loading…</p>
<form class="np" id="np-form" hidden novalidate>
<p class="h">Makes the folder in <span id="np-ws"></span>, a git repository on main with a README.md and a REPO_MAP.md, the T3 Code project, and its entries in repositories.json and REPOSITORIES.md.</p>
<label><span>Group</span><select id="np-group"></select></label>
<label><span>Repo name</span><input id="np-name" maxlength="100" autocomplete="off" spellcheck="false"><span class="h" id="np-rule"></span><span class="bad" id="np-bad"></span></label>
<p class="h">Folder: <strong id="np-folder">none yet</strong></p>
<label><span>Purpose <span class="h">one sentence: what the project is for</span></span><input id="np-purpose" maxlength="300"></label>
<label><span>Title <span class="h">optional: the T3 Code project's title; the repo name by default</span></span><input id="np-title" maxlength="100"></label>
<label><span>Notes <span class="h">optional: they go into the README, the map and the catalogue</span></span><textarea id="np-notes" rows="2" maxlength="2000"></textarea></label>
<label><span>First request <span class="h">optional: filed in the new project once it is made</span></span><textarea id="np-request" rows="3" maxlength="8000"></textarea></label>
<div class="actions"><button type="submit" class="primary" id="np-create">Create</button></div><p class="bad" id="np-warn"></p>
</form><div id="np-result"></div></section>`

/**
 * The New project form's script. The page's checks (a group, the name rule, a purpose) only save a round trip:
 * `superagent_new_project` checks everything again. `newProjectArgs` is all Create sends; the group "/" is the top level of
 * the workspace.
 */
const FORM_SCRIPT = `const NAME=new RegExp(${JSON.stringify(SEGMENT.source)}),RULE=${JSON.stringify(NAME_RULE)},PART_WAY=${JSON.stringify(PART_WAY)};
// What T3 Code answers when it does not pass a tools/call on to the server, so the tool did not run.
const DECLINED='Declined by the user.',NOT_SENT=[DECLINED,'This app cannot call that tool.','T3 could not ask for approval here.','Too many requests in flight.'];
function nameProblem(name){const n=String(name??'').trim();if(!n)return 'Give the repo a name.';
  return NAME.test(n)&&!/[. ]$/.test(n)&&!n.endsWith('.lock')&&n.length<=100?'':'"'+n+'" cannot be a folder name: '+RULE}
const folderOf=(group,name)=>group==='/'?String(name).trim():group+'/'+String(name).trim();
function formValues(){return {group:$('np-group').value,name:$('np-name').value,purpose:$('np-purpose').value,title:$('np-title').value,
  notes:$('np-notes').value,request:$('np-request').value}}
function formProblem(f){if(!f.group)return 'Choose a group.';return nameProblem(f.name)||(f.purpose.trim()?'':'Give the purpose: one sentence on what the project is for.')}
// Optional fields left empty are not sent, so the tool uses its defaults.
function newProjectArgs(f){const args={folder:folderOf(f.group,f.name),purpose:f.purpose.trim()};
  for(const k of ['title','notes','request'])if(f[k]&&f[k].trim())args[k]=f[k].trim();return args}
// A first request the Router has not decided on within the wait is normal; the line says how to follow it.
function requestLine(req){if(req.refused)return 'refused: '+req.refused;
  if(req.status==='pending')return 'filed in '+req.filed_in+', not decided yet. That is normal: the Router decides in a moment, and the ticket then '
    +'shows in the project\\'s T3 Code threads. To see what became of it, ask the console, or call superagent_ticket with '+req.trigger_id+'.';
  return (req.result||req.status||'')+(req.repeated?' (filed by an earlier Create)':'')}
function madeHtml(r){const li=(label,text)=>'<li>'+esc(label)+': '+esc(text)+'</li>',req=r.request,warnings=[];
  if(r.status!=='ready')warnings.push('Its status is '+r.status+(r.why?': '+r.why:'.'));
  if(String(r.catalogue).startsWith('not changed'))warnings.push('repositories.json was '+r.catalogue);
  if(String(r.index).startsWith('not changed'))warnings.push('REPOSITORIES.md was '+r.index);
  if(req&&req.refused)warnings.push('The first request was refused: '+req.refused);
  return '<div class="res ok"><p><strong>Created '+esc(r.key)+'</strong>, status '+esc(r.status)+'.'+(r.repeated?' This finished a job an earlier Create started.':'')+'</p><ul>'
    +li('Folder',r.root)+li('Git','branch '+r.branch+', first commit '+String(r.head||'').slice(0,7)+' with README.md and REPO_MAP.md')
    +li('T3 Code project','"'+r.title+'" ('+r.project_id+')')+li('repositories.json',r.catalogue+(r.scope?'; scope line '+r.scope:''))
    +li('REPOSITORIES.md',r.index)+((r.backups||[]).length?li('Backups',r.backups.join(', ')):'')
    +(req?li('First request',requestLine(req)):'')+'</ul>'
    +(warnings.length?'<p>Warnings:</p><ul class="warn">'+warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul>':'')
    +'<p><strong>Left to you:</strong> '+esc(r.manual_step)+'</p></div>'}
function failedHtml(e){const text=e&&e.message||String(e);
  if(e&&e.fromTool&&text.includes(PART_WAY))return '<div class="res partway"><p><strong>Stopped part way.</strong> Press Create again with the same values '
    +'to finish the job; nothing is made twice.</p><p class="s">'+esc(text)+'</p></div>';
  if(e&&e.fromTool)return '<div class="res refused"><p><strong>Not created.</strong> This Create changed nothing.</p><p class="s">'+esc(text)+'</p></div>';
  if(e&&e.fromHost&&NOT_SENT.includes(text))return '<div class="res refused"><p><strong>Not created.</strong> '+(text===DECLINED
    ?'The permission prompt in T3 Code was declined, so superagent_new_project did not run and nothing was made.'
    :'T3 Code did not run superagent_new_project, so nothing was made.')+'</p><p class="s">'+esc(text)+'</p></div>';
  return '<div class="res partway"><p><strong>No answer came back.</strong> The job may have run on: press Create again with the same values to finish it '
    +'or to see what it made.</p><p class="s">'+esc(text)+'</p></div>'}
function showFolder(){const f=formValues(),bad=f.name.trim()?nameProblem(f.name):'';$('np-bad').textContent=bad;
  $('np-folder').textContent=f.group&&f.name.trim()&&!bad?folderOf(f.group,f.name):'none yet'}
let creating=false;
async function createProject(){if(creating)return;const f=formValues(),out=$('np-result'),problem=formProblem(f);
  if(problem){out.innerHTML='<div class="res refused"><p>'+esc(problem)+'</p></div>';return}
  const args=newProjectArgs(f),button=$('np-create'),since=Date.now();creating=true;button.disabled=true;
  const tick=()=>{button.textContent='Creating… '+Math.round((Date.now()-since)/1000)+' s'};tick();const timer=setInterval(tick,1000);
  out.innerHTML='<div class="res"><p>Creating '+esc(args.folder)+': the folder, the git repository and its first commit, the T3 Code project and the '
    +'catalogue entries'+(args.request?', then the first request':'')+'.</p></div>';
  try{out.innerHTML=madeHtml(await call('superagent_new_project',args))}catch(e){out.innerHTML=failedHtml(e)}
  finally{clearInterval(timer);creating=false;button.disabled=false;button.textContent='Create'}}
let npLoaded=false;
async function loadNewProject(){const off=$('np-off'),form=$('np-form');if(!off||!form||npLoaded)return;npLoaded=true;let o;
  try{o=await call('superagent_new_project_options',{})}catch(e){off.textContent='The form could not load: '+e.message;return}
  if(!o||!o.enabled){off.innerHTML='<strong>New projects are off.</strong> '+esc(o&&o.why)+' '+esc(o&&o.enable);return}
  if(!o.groups.length&&!o.top_level){off.textContent='No folder of '+o.workspace+' can take a new project: the catalogue files projects under no top-level '
    +'folder that is not denied, and the top level cannot take one either. In the console, superagent_new_project takes any folder.';return}
  $('np-group').innerHTML='<option value="">Choose a group</option>'+o.groups.map(g=>'<option value="'+esc(g)+'">'+esc(g)+'/</option>').join('')
    +(o.top_level?'<option value="/">The top level of the workspace</option>':'');
  $('np-ws').textContent=o.workspace;$('np-rule').textContent=o.name_rule;$('np-warn').textContent=o.warning||'';
  form.addEventListener('submit',e=>{e.preventDefault();createProject()});form.addEventListener('input',showFolder);form.addEventListener('change',showFolder);
  off.hidden=true;form.hidden=false}
`

/** The attention queue's script: drawing the list, its buttons, and the panel's refresh every 15 seconds, which writes only `#list` and `#note`. */
const ATTENTION_SCRIPT = `function questionHtml(q){return '<div class="pq" data-req="'+esc(q.requestId)+'" data-qid="'+esc(q.id)+'" data-multi="'+(q.multiSelect?'1':'')+'">'
  +(q.header?'<div class="h">'+esc(q.header)+'</div>':'')+'<p class="q">'+esc(q.question)+'</p>'
  +((q.options||[]).length?'<ul class="opts">'+q.options.map(o=>'<li><button data-do="pick" data-value="'+esc(o.value??o.label)+'">'+esc(o.label)+'</button>'
    +(o.description?'<span class="d">'+esc(o.description)+'</span>':'')+'</li>').join('')+'</ul>':'')+'</div>'}
function ticketHtml(t){const action=t.stage.split('/')[1]||t.stage,p=t.pending||{approvals:[],questions:[]};
  const asks=!!t.question||p.questions.length>0;
  return '<div class="row" data-id="'+esc(t.id)+'">'
    +'<div class="top"><span class="id">'+esc(t.short)+'</span><strong>'+esc(t.title)+'</strong><span class="stage '+esc(action)+'">'+esc(action)+'</span></div>'
    +(t.question?'<p class="q">'+esc(t.question)+'</p>':'')
    +p.approvals.map(a=>'<p class="approval">'+esc(a.text)+'</p>').join('')
    +p.questions.map(questionHtml).join('')
    +(t.summary?'<p class="s">'+esc(t.summary)+'</p>':'')
    +'<div class="actions">'+(asks?'<button data-do="answer">Answer</button>':'')
    +((action==='blocked'||action==='failed'||action==='delivery')?'<button data-do="retry">Retry</button>':'')
    +'<button data-do="stop">Stop</button>'
    +(t.link?(p.approvals.length?'<a class="btn primary" href="'+esc(t.link)+'" target="_blank" rel="noopener">Approve in T3 Code</a>'
      :'<a class="btn" href="'+esc(t.link)+'" target="_blank" rel="noopener">Open thread</a>'):'')+'</div></div>'}
function alertHtml(a){const computed=String(a.id).startsWith('pending:');
  return '<div class="row" data-alert="'+esc(a.id)+'"><div class="top"><span class="stage '+(computed?'approve':'failed')+'">watchdog</span>'
    +'<span class="id">'+esc(new Date(a.at).toLocaleString())+'</span></div><p class="q">'+esc(a.text)+'</p>'
    +'<div class="actions">'+(computed?'':'<button data-do="dismiss">Dismiss</button>')
    +(a.link?'<a class="btn'+(computed?' primary':'')+'" href="'+esc(a.link)+'" target="_blank" rel="noopener">'+(computed?'Answer in T3 Code':'Open thread')+'</a>':'')
    +'</div></div>'}
function reviewHtml(r){return '<div class="row review"><div class="top"><span class="id">'+esc(r.short)+'</span><strong>'+esc(r.title)+'</strong>'
  +'<span class="stage review">'+esc(r.project)+'</span></div><p class="s">Branch '+esc(r.branch)+', not in '+esc(r.into)+' yet.'
  +(r.summary?' '+esc(r.summary):'')+'</p>'+(r.cleanup||[]).map(c=>'<code>'+esc(c)+'</code>').join('')
  +(r.link?'<div class="actions"><a class="btn" href="'+esc(r.link)+'" target="_blank" rel="noopener">Open thread</a></div>':'')+'</div>'}
function render(data){const items=(data&&data.tickets)||[],alerts=(data&&data.alerts)||[],review=(data&&data.to_review)||[];
  const list=document.getElementById('list');
  if(!items.length&&!alerts.length&&!review.length){list.innerHTML='<div class="empty">Nothing waits for a person.</div>';return}
  list.innerHTML=alerts.map(alertHtml).join('')+items.map(ticketHtml).join('')
    +(review.length?'<h2>To review / merge</h2>'+review.map(reviewHtml).join(''):'')}
// The answer boxes: one under each T3 Code question, or one for the question the worker asked in its report.
function openBoxes(row){if(row.querySelector('textarea'))return false;const qs=row.querySelectorAll('.pq');
  const add=(before,qid,multi)=>{const box=document.createElement('textarea');box.rows=qid?2:3;box.placeholder=multi?'Your answers, one per line':'Your answer';
    if(qid)box.dataset.qid=qid;before.after(box);return box};
  let first;if(qs.length)qs.forEach(q=>{const box=add(q,q.dataset.qid,!!q.dataset.multi);first=first||box});else{const box=document.createElement('textarea');box.rows=3;
    box.placeholder='Your answer';row.querySelector('.actions').before(box);first=box}
  const b=row.querySelector('button[data-do=answer]');if(b)b.textContent='Send answer';if(first)first.focus();return true}
const lines=s=>s.split('\\n').map(v=>v.trim()).filter(Boolean);
async function sendAnswer(row,id){const qs=[...row.querySelectorAll('.pq')];
  if(!qs.length){const box=row.querySelector('textarea');if(!box||!box.value.trim())return false;await call('superagent_answer',{ticket_id:id,text:box.value.trim()});return true}
  const byRequest=new Map();for(const q of qs){const box=q.nextElementSibling,value=box&&box.value.trim();if(!value)continue;
    // A multiple choice holds one answer per line, since an option's label may contain commas.
    const answer=q.dataset.multi?lines(value):value;
    if(!byRequest.has(q.dataset.req))byRequest.set(q.dataset.req,{text:value,answers:{}});byRequest.get(q.dataset.req).answers[q.dataset.qid]=answer}
  if(!byRequest.size)return false;for(const r of byRequest.values())await call('superagent_answer',{ticket_id:id,text:r.text,answers:r.answers});return true}
async function refresh(){try{render(await call('superagent_attention',{}))}catch(e){document.getElementById('note').textContent=e.message}}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-do]');if(!b)return;const row=b.closest('.row'),id=row.dataset.id,what=b.dataset.do;
  try{if(what==='dismiss'){await call('superagent_dismiss_alert',{alert_id:row.dataset.alert})}
    else if(what==='pick'){openBoxes(row);const q=b.closest('.pq'),box=q&&q.nextElementSibling;if(!box)return;const v=b.dataset.value;
      if(q.dataset.multi){const all=lines(box.value);box.value=(all.includes(v)?all.filter(x=>x!==v):[...all,v]).join('\\n')}else box.value=v;return}
    else if(what==='answer'){if(openBoxes(row))return;if(!await sendAnswer(row,id))return}
    else if(what==='retry')await call('superagent_retry',{ticket_id:id});else if(what==='stop')await call('superagent_stop',{ticket_id:id});
    document.getElementById('note').textContent='Done.';await refresh()}catch(err){document.getElementById('note').textContent=err.message}});
function toolResult(params){render(params&&params.structuredContent)}
function trouble(text){document.getElementById('note').textContent=text}
// The MCP App draws the tool's own result; the panel fetches the list itself, every 15 seconds, and fills the form once.
function started(){if(MODE==='app')return;refresh();setInterval(refresh,15000);if(typeof loadNewProject==='function')loadNewProject()}
`

/**
 * The attention queue: the MCP App `superagent_attention` draws (`mode` "app"), or the panel (`mode` "panel", with this
 * service's API at `apiBase`), which also has the New project form below the queue.
 */
export function attentionPage(mode: Mode, apiBase = ''): string {
  const panel = mode === 'panel'
  return page({ title: 'Superagent attention', mode, apiBase, app: 'superagent-attention', ...panel ? { style: FORM_STYLE } : {},
    body: `<h1>Needs a person</h1><div id="list"><div class="empty">Loading…</div></div><div class="note" id="note"></div>${panel ? `\n${formHtml('sec')}` : ''}`,
    script: (panel ? FORM_SCRIPT : '') + ATTENTION_SCRIPT })
}

/**
 * The New project form on its own, as the MCP App `superagent_new_project_form` draws in the console thread. It fills itself
 * from `superagent_new_project_options` and runs `superagent_new_project` by `tools/call`, so nothing passes through a model.
 * `mode` "panel" serves the same page over this service's API at `apiBase`, which the tests use.
 */
export function newProjectPage(mode: Mode = 'app', apiBase = ''): string {
  return page({ title: 'Superagent new project', mode, apiBase, app: 'superagent-new-project', style: FORM_STYLE, body: formHtml(''),
    script: `${FORM_SCRIPT}// The form fills itself from superagent_new_project_options, so the tool's own result is not needed here.
function toolResult(){}
function trouble(text){$('np-off').textContent=text}
function started(){return loadNewProject()}
` })
}

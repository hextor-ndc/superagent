/**
 * Point 3: the "needs a person" queue, drawn inside t3code. One self-contained page serves two hosts:
 * - as an MCP App (`ui://superagent/attention`), which t3code renders in the console thread in place of the tool call. It
 *   talks to t3code over the MCP Apps postMessage protocol and calls the console tools for its buttons;
 * - as the plain panel at `/panel/<token>`, for t3code's browser tab, where it uses this service's HTTP API.
 * A worker thread that waits in t3code shows its approvals with a link to approve them in T3 Code (nothing here can grant
 * one), and its questions with their options and an Answer button. Below them, "To review / merge" lists finished tickets of
 * projects without pull requests whose branch is not merged yet, with the commands that clean up after them.
 */
export const ATTENTION_URI = 'ui://superagent/attention'
export const MCP_APP_MIME = 'text/html;profile=mcp-app'
const PROTOCOL = '2026-01-26'

export function attentionPage(mode: 'app' | 'panel', apiBase = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Superagent attention</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e8;--chip:#f2f2f5;--accent:#2f6fde;--warn:#b25a00;--bad:#c0362c}
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
h2{font-size:13px;margin:16px 0 4px;color:var(--muted)}code{display:block;font-size:12px;color:var(--muted);white-space:pre-wrap;word-break:break-all;margin:2px 0 0}
</style></head><body>
<h1>Needs a person</h1><div id="list"><div class="empty">Loading…</div></div><div class="note" id="note"></div>
<script>
const MODE=${JSON.stringify(mode)},API=${JSON.stringify(apiBase)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let seq=0;const waiting=new Map();
function rpc(method,params){if(MODE!=='app')return Promise.reject(new Error('not an app'));const id=++seq;
  parent.postMessage({jsonrpc:'2.0',id,method,params},'*');return new Promise((ok,no)=>waiting.set(id,{ok,no}))}
function notify(method,params){parent.postMessage({jsonrpc:'2.0',method,params},'*')}
async function call(name,args){
  if(MODE==='app'){const r=await rpc('tools/call',{name,arguments:args});if(r&&r.isError)throw new Error((r.content||[]).map(c=>c.text).join(' '));return r&&r.structuredContent}
  const r=await fetch(API+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});
  if(!r.ok)throw new Error(await r.text());return r.json()}
function questionHtml(q){return '<div class="pq" data-req="'+esc(q.requestId)+'" data-qid="'+esc(q.id)+'" data-multi="'+(q.multiSelect?'1':'')+'">'
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
if(MODE==='app'){
  window.addEventListener('message',e=>{const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
    if(m.id!==undefined&&waiting.has(m.id)){const w=waiting.get(m.id);waiting.delete(m.id);m.error?w.no(new Error(m.error.message)):w.ok(m.result);return}
    if(m.method==='ui/notifications/tool-result'){render(m.params&&m.params.structuredContent)}
    if(m.method==='ui/notifications/host-context-changed'&&m.params&&m.params.theme)document.documentElement.dataset.theme=m.params.theme});
  rpc('ui/initialize',{protocolVersion:${JSON.stringify(PROTOCOL)},appInfo:{name:'superagent-attention',version:'0.1.0'},appCapabilities:{}})
    .then(r=>{const t=r&&r.hostContext&&r.hostContext.theme;if(t)document.documentElement.dataset.theme=t;notify('ui/notifications/initialized',{})})
    .catch(e=>{document.getElementById('note').textContent=e.message});
}else{refresh();setInterval(refresh,15000)}
</script></body></html>`
}

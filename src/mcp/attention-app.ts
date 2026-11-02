/**
 * Point 3: the "needs a person" queue, drawn inside t3code. One self-contained page serves two hosts:
 * - as an MCP App (`ui://superagent/attention`), which t3code renders in the console thread in place of the tool call. It
 *   talks to t3code over the MCP Apps postMessage protocol and calls the console tools for its buttons;
 * - as the plain panel at `/panel/<token>`, for t3code's browser tab, where it uses this service's HTTP API.
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
.stage.blocked{color:var(--warn)}.stage.failed,.stage.delivery{color:var(--bad)}
.q{margin:6px 0 0}.s{margin:4px 0 0;color:var(--muted);white-space:pre-wrap}
.actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
button,a.btn{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer;text-decoration:none}
textarea{width:100%;box-sizing:border-box;margin-top:6px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px}
.note{color:var(--muted);font-size:12px;margin-top:10px}
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
function render(data){const items=(data&&data.tickets)||[];const list=document.getElementById('list');
  if(!items.length){list.innerHTML='<div class="empty">Nothing waits for a person.</div>';return}
  list.innerHTML=items.map(t=>{const action=t.stage.split('/')[1]||t.stage;return '<div class="row" data-id="'+esc(t.id)+'">'
    +'<div class="top"><span class="id">'+esc(t.short)+'</span><strong>'+esc(t.title)+'</strong><span class="stage '+esc(action)+'">'+esc(action)+'</span></div>'
    +(t.question?'<p class="q">'+esc(t.question)+'</p>':'')+(t.summary?'<p class="s">'+esc(t.summary)+'</p>':'')
    +'<div class="actions">'+(t.question?'<button data-do="answer">Answer</button>':'')
    +((action==='blocked'||action==='failed'||action==='delivery')?'<button data-do="retry">Retry</button>':'')
    +'<button data-do="stop">Stop</button>'+(t.link?'<a class="btn" href="'+esc(t.link)+'" target="_blank" rel="noopener">Open thread</a>':'')+'</div></div>'}).join('')}
async function refresh(){try{render(await call('superagent_attention',{}))}catch(e){document.getElementById('note').textContent=e.message}}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-do]');if(!b)return;const row=b.closest('.row'),id=row.dataset.id,what=b.dataset.do;
  try{if(what==='answer'){let box=row.querySelector('textarea');if(!box){box=document.createElement('textarea');box.rows=3;box.placeholder='Your answer';
      row.querySelector('.actions').before(box);b.textContent='Send answer';box.focus();return}
      if(!box.value.trim())return;await call('superagent_answer',{ticket_id:id,text:box.value.trim()})}
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

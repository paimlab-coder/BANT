'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'radar-data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COUNTRIES = {
  BR: { name: 'Brasil', hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419', lang: 'pt-BR' },
  CL: { name: 'Chile', hl: 'es-419', gl: 'CL', ceid: 'CL:es-419', lang: 'es' },
  AR: { name: 'Argentina', hl: 'es-419', gl: 'AR', ceid: 'AR:es-419', lang: 'es' },
  PY: { name: 'Paraguai', hl: 'es-419', gl: 'PY', ceid: 'PY:es-419', lang: 'es' },
  UY: { name: 'Uruguai', hl: 'es-419', gl: 'UY', ceid: 'UY:es-419', lang: 'es' }
};
const TERMS = {
  BR: [
    '("centro de distribuição" OR "centro logístico") (investimento OR construção OR expansão OR inauguração)',
    '(indústria OR fábrica) (ampliação OR expansão OR investimento) logística armazenagem',
    '(armazém OR galpão logístico) (novo OR construção OR expansão) Brasil'
  ],
  CL: [
    '("centro de distribución" OR "centro logístico") (inversión OR construcción OR expansión)',
    '(industria OR fábrica) (ampliación OR inversión) logística almacenamiento'
  ],
  AR: [
    '("centro de distribución" OR "centro logístico") (inversión OR construcción OR expansión)',
    '(industria OR fábrica) (ampliación OR inversión) logística almacenamiento'
  ],
  PY: [
    '("centro de distribución" OR "centro logístico") (inversión OR construcción OR expansión)',
    '(industria OR fábrica) (ampliación OR inversión) logística almacenamiento'
  ],
  UY: [
    '("centro de distribución" OR "centro logístico") (inversión OR construcción OR expansión)',
    '(industria OR fábrica) (ampliación OR inversión) logística almacenamiento'
  ]
};
const POSITIVE = [
  ['novo centro de distribuição', 5], ['centro de distribuição', 4], ['centro logístico', 4],
  ['investimento', 3], ['investirá', 4], ['expansão', 3], ['ampliação', 3], ['inaugura', 3],
  ['construção', 2], ['armazém', 2], ['galpão', 2], ['armazenagem', 3], ['automação', 3],
  ['verticalização', 4], ['planta industrial', 3], ['nova unidade', 3], ['logística', 1],
  ['centro de distribución', 4], ['inversión', 3], ['expansión', 3], ['ampliación', 3],
  ['inaugura', 3], ['construcción', 2], ['almacenamiento', 3], ['automatización', 3],
  ['nueva planta', 3], ['nuevo centro', 3], ['bodega', 2]
];
const NEGATIVE = ['vaga', 'emprego', 'curso', 'acidente', 'roubo', 'furto', 'falência', 'recuperação judicial'];

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ leads: [], runs: [], settings: { dailyEnabled: true, dailyHour: 7, countries: ['BR','CL','AR','PY','UY'] }, importedCnpjs: [] }, null, 2));
  }
}
function readDb() { ensureDb(); try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { leads: [], runs: [], settings: {}, importedCnpjs: [] }; } }
function writeDb(db) { ensureDb(); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DB_FILE); }
function send(res, status, data, headers={}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers }); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', c => { body += c; if (body.length > 2_000_000) reject(new Error('Corpo muito grande')); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON inválido')); } }); req.on('error', reject); }); }
function decodeXml(s='') { return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim(); }
function tag(xml, name) { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')); return m ? decodeXml(m[1]).replace(/<[^>]+>/g,'').trim() : ''; }
function inferCompany(title='') {
  const verbs = [' anuncia ', ' investe ', ' investirá ', ' inaugura ', ' amplia ', ' expande ', ' construirá ', ' construye ', ' inicia ', ' abrirá ', ' abre ', ' planeja ', ' construirá ', ' inaugura ', ' invertirá ', ' ampliará '];
  const low = ' ' + title.toLocaleLowerCase('pt-BR') + ' ';
  for (const v of verbs) { const i = low.indexOf(v); if (i > 2) return title.slice(0, i - 1).replace(/^[\s"'“”]+|[\s"'“”]+$/g,'').slice(0,90); }
  return '';
}
function score(title, description='') {
  const text = (title + ' ' + description).toLocaleLowerCase('pt-BR');
  let points = 0; const matches=[];
  for (const [word, value] of POSITIVE) if (text.includes(word)) { points += value; matches.push(word); }
  for (const word of NEGATIVE) if (text.includes(word)) points -= 3;
  return { score: Math.max(0, Math.min(20, points)), matches: [...new Set(matches)].slice(0,8) };
}
function priority(n) { return n >= 12 ? 'A' : n >= 7 ? 'B' : 'C'; }
function cleanUrl(u) { try { const x = new URL(u); return ['http:','https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } }
async function fetchGoogleNews(query, code) {
  const c = COUNTRIES[code];
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(c.hl)}&gl=${c.gl}&ceid=${encodeURIComponent(c.ceid)}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'RadarBSA/2.0 (+public-market-research)' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Google News RSS respondeu ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return items.map(item => {
    const title = tag(item, 'title'); const link = cleanUrl(tag(item, 'link'));
    const pubDate = tag(item, 'pubDate'); const source = tag(item, 'source');
    const description = tag(item, 'description');
    if (!title || !link) return null;
    const s = score(title, description);
    return { title, url: link, publishedAt: pubDate ? new Date(pubDate).toISOString() : null, source: source || 'Google News RSS', description: description.replace(/<[^>]*>/g,' ').slice(0,500), country: code, countryName: c.name, score: s.score, matches: s.matches, priority: priority(s.score), company: inferCompany(title), status: 'Novo', contactName: '', contactRole: '', email: '', phone: '', website: '', address: '', notes: '', verified: false, id: crypto.createHash('sha1').update(link).digest('hex'), foundAt: new Date().toISOString() };
  }).filter(Boolean);
}
async function runSearch(codes) {
  const db = readDb(); const started = new Date(); const errors=[]; const collected=[]; let queriesRun=0;
  for (const code of codes) {
    if (!COUNTRIES[code]) continue;
    for (const q of (TERMS[code] || [])) {
      queriesRun++;
      try { const rows = await fetchGoogleNews(q, code); collected.push(...rows); }
      catch (e) { errors.push(`${COUNTRIES[code].name}: ${e.message}`); }
    }
  }
  const existing = new Map((db.leads || []).map(x => [x.id, x])); let added=0; let updated=0;
  for (const item of collected) {
    const old = existing.get(item.id);
    if (old) { existing.set(item.id, { ...item, ...old, lastSeenAt: new Date().toISOString() }); updated++; }
    else { existing.set(item.id, item); added++; }
  }
  db.leads = [...existing.values()].sort((a,b) => (b.score||0)-(a.score||0) || new Date(b.publishedAt||0)-new Date(a.publishedAt||0));
  const run = { id: crypto.randomUUID(), startedAt: started.toISOString(), finishedAt: new Date().toISOString(), countries: codes, queriesRun, found: collected.length, added, updated, errors };
  db.runs = [run, ...(db.runs||[])].slice(0,100); db.lastRun = run; writeDb(db); return run;
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const sep = (lines[0].match(/;/g)||[]).length > (lines[0].match(/,/g)||[]).length ? ';' : ',';
  const split = line => { const out=[]; let cur='', quoted=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"' && line[i+1]==='"' && quoted){cur+='"';i++;} else if(ch==='"') quoted=!quoted; else if(ch===sep && !quoted){out.push(cur.trim());cur='';} else cur+=ch;} out.push(cur.trim()); return out; };
  const headers = split(lines[0]).map(x=>x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''));
  return lines.slice(1).map(line=>{const vals=split(line); const obj={}; headers.forEach((h,i)=>obj[h]=vals[i]||''); return obj;}).filter(x=>Object.values(x).some(Boolean));
}
function staticFile(req,res,pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  p = path.normalize(p).replace(/^([.][.][/\\])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return send(res,403,{error:'Acesso negado'});
  fs.readFile(file,(err,data)=>{ if(err) return send(res,404,{error:'Arquivo não encontrado'}); const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}; res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream'});res.end(data); });
}
const server = http.createServer(async (req,res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const p=u.pathname;
  try {
    if (p === '/api/health') return send(res,200,{ok:true,app:'Radar BSA',version:'2.0.0',time:new Date().toISOString(),storage:DB_FILE});
    if (p === '/api/status') { const db=readDb(); return send(res,200,{lastRun:db.lastRun||null,settings:db.settings||{},leadCount:(db.leads||[]).length,storage:DB_FILE}); }
    if (p === '/api/leads' && req.method === 'GET') { const db=readDb(); let rows=db.leads||[]; const country=u.searchParams.get('country'); const priorityFilter=u.searchParams.get('priority'); const q=(u.searchParams.get('q')||'').toLowerCase(); if(country) rows=rows.filter(x=>x.country===country); if(priorityFilter) rows=rows.filter(x=>x.priority===priorityFilter); if(q) rows=rows.filter(x=>[x.title,x.company,x.source,x.description,x.countryName].join(' ').toLowerCase().includes(q)); return send(res,200,{leads:rows,total:rows.length}); }
    if (p === '/api/runs') { const db=readDb(); return send(res,200,{runs:db.runs||[]}); }
    if (p === '/api/search' && req.method === 'POST') { const body=await readBody(req); const codes=Array.isArray(body.countries)&&body.countries.length?body.countries:['BR','CL','AR','PY','UY']; const run=await runSearch(codes); return send(res,200,{ok:true,run}); }
    if (p.startsWith('/api/leads/') && req.method === 'PATCH') { const id=p.split('/').pop(); const body=await readBody(req); const db=readDb(); const i=(db.leads||[]).findIndex(x=>x.id===id); if(i<0) return send(res,404,{error:'Lead não encontrado'}); const allowed=['company','website','address','contactName','contactRole','email','phone','notes','status','verified']; for(const k of allowed) if(body[k]!==undefined) db.leads[i][k]=body[k]; db.leads[i].updatedAt=new Date().toISOString(); writeDb(db); return send(res,200,{ok:true,lead:db.leads[i]}); }
    if (p === '/api/import/cnpj' && req.method === 'POST') { const body=await readBody(req); const rows=parseCsv(body.csv||''); const db=readDb(); const seen=new Set((db.importedCnpjs||[]).map(x=>x.cnpj)); let added=0; for(const r of rows){const cnpj=(r.cnpj||r.numero_de_inscricao||r.cnpj_basico||'').replace(/\D/g,''); if(!cnpj || seen.has(cnpj)) continue; const item={cnpj,razaoSocial:r.razao_social||r.nome_empresarial||'',nomeFantasia:r.nome_fantasia||'',uf:r.uf||'',municipio:r.municipio||'',cnae:r.cnae_fiscal_principal||r.cnae||'',dataAbertura:r.data_de_inicio_atividade||r.data_de_abertura||r.data_abertura||'',importedAt:new Date().toISOString()}; db.importedCnpjs.push(item); seen.add(cnpj); added++;} writeDb(db); return send(res,200,{ok:true,rowsRead:rows.length,added,total:db.importedCnpjs.length,note:'A importação organiza os registros fornecidos; para detectar novos CNPJs, compare arquivos de competências diferentes.'}); }
    if (p === '/api/cnpj' && req.method === 'GET') { const db=readDb(); return send(res,200,{records:db.importedCnpjs||[],total:(db.importedCnpjs||[]).length}); }
    if (p === '/api/export' && req.method === 'GET') { const db=readDb(); res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="radar-bsa-backup.json"'}); return res.end(JSON.stringify(db,null,2)); }
    if (p === '/api/settings' && req.method === 'PATCH') { const body=await readBody(req); const db=readDb(); db.settings={...db.settings,...body}; writeDb(db); return send(res,200,{ok:true,settings:db.settings}); }
    return staticFile(req,res,p);
  } catch(e) { console.error('[RADAR ERROR]',e); return send(res,500,{error:e.message||'Erro interno'}); }
});

function msUntilNextRun(hour=7) {
  const zone = 'America/Sao_Paulo';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const localNow = new Date(`${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}-03:00`);
  let target = new Date(localNow); target.setHours(hour,0,0,0); if (target <= localNow) target.setDate(target.getDate()+1);
  return Math.max(1000, target.getTime() - localNow.getTime());
}
function scheduleDaily() { const db=readDb(); const enabled=db.settings?.dailyEnabled!==false; const hour=Number(db.settings?.dailyHour ?? 7); if(!enabled) return; setTimeout(async()=>{ try { console.log('[RADAR] Iniciando atualização diária'); const current=readDb(); await runSearch(current.settings?.countries||['BR','CL','AR','PY','UY']); console.log('[RADAR] Atualização diária concluída'); } catch(e) { console.error('[RADAR] Falha na atualização diária',e); } scheduleDaily(); },msUntilNextRun(hour)); }
ensureDb();
server.listen(PORT,()=>{console.log(`Radar BSA ativo na porta ${PORT}`);scheduleDaily();});

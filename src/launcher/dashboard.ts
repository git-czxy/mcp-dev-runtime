import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { NAME, VERSION } from '../version.js';
import { current } from './supervisor.js';
import type { ResolvedLaunchOptions } from './options.js';

type DashboardOptions = {
  launch: ResolvedLaunchOptions;
  managementArgs: string[];
  doctorArgs: string[];
  port?: number;
  open?: boolean;
};

type CommandResult = { ok: boolean; code: number | null; stdout: string; stderr: string };

const MAX_COMMAND_OUTPUT = 512 * 1024;
const MAX_REQUEST_BODY = 4096;
const DASHBOARD_IDLE_MS = 10 * 60 * 1000;
const DASHBOARD_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="MCP Dev Runtime">
<rect x="2" y="2" width="60" height="60" rx="14" fill="#17283f"/>
<path d="M21 22l8 8-8 8" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M32 40h12" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/>
</svg>`;

function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
  return parsed as Record<string, unknown>;
}

function runCli(args: string[], timeoutMs = 150_000): Promise<CommandResult> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false, finished = false;
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = String(chunk);
      if (stdout.length + stderr.length + text.length > MAX_COMMAND_OUTPUT) { overflow = true; return; }
      if (target === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    const timer = setTimeout(() => { if (!finished) child.kill('SIGTERM'); }, timeoutMs);
    child.on('error', error => { stderr += error.message; });
    child.on('close', code => {
      finished = true; clearTimeout(timer);
      if (overflow) stderr += '\n[dashboard truncated oversized command output]';
      resolve({ ok: code === 0 && !overflow, code, stdout, stderr });
    });
  });
}

async function statusPayload(o: ResolvedLaunchOptions) {
  const state = await current(o.state_dir) as Record<string, any>;
  let configuredMcp: { host?: string; port?: number; path?: string } = {};
  try {
    const config = await loadConfig(o.runtime_config);
    configuredMcp = { host: config.host, port: config.port, path: config.mcp_path };
  } catch {}
  const health = (state.health ?? {}) as Record<string, any>;
  const mcp = (health.mcp ?? {}) as Record<string, any>;
  const tunnel = (health.tunnel ?? {}) as Record<string, any>;
  const details = (mcp.details ?? {}) as Record<string, any>;
  const lifecycle = String(state.state ?? 'unknown');
  const availability = String(health.availability ?? lifecycle);
  const running = lifecycle === 'ready' && availability === 'ready';
  const stopped = lifecycle === 'stopped';
  const working = lifecycle === 'starting' || lifecycle === 'stopping';
  const mode = running ? 'running' : stopped ? 'stopped' : working ? 'working' : 'recovery';
  const configuredUrl = configuredMcp.host && configuredMcp.port
    ? `http://${configuredMcp.host.includes(':') ? '[' + configuredMcp.host + ']' : configuredMcp.host}:${configuredMcp.port}${configuredMcp.path ?? '/mcp'}`
    : null;
  return {
    name: NAME,
    version: state.version ?? VERSION,
    mode,
    lifecycle,
    availability,
    managed: state.managed === true,
    mcp: {
      state: stopped ? 'stopped' : mcp.ok === true ? 'ready' : mcp.ok === false ? 'degraded' : 'unknown',
      url: state.mcp_url ?? configuredUrl,
      latency_ms: typeof mcp.latency_ms === 'number' ? mcp.latency_ms : null
    },
    tunnel: {
      state: o.tunnel_enabled === false || tunnel.disabled === true ? 'disabled' : stopped ? 'stopped' : tunnel.ok === true ? 'ready' : tunnel.ok === false ? 'degraded' : 'unknown',
      latency_ms: typeof tunnel.latency_ms === 'number' ? tunnel.latency_ms : null
    },
    uptime_seconds: typeof details.uptime_seconds === 'number' ? details.uptime_seconds : null,
    checked_at: health.checked_at ?? null,
    details: {
      state_dir: o.state_dir,
      logs_dir: o.logs_dir ?? o.state_dir,
      config_file: o.configuration_file,
      supervisor_pid: state.pid ?? null,
      mcp_pid: state.mcp_pid ?? null,
      tunnel_pid: state.tunnel_pid ?? null
    }
  };
}

async function openBrowser(url: string) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function page(token: string, nonce: string) {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Dev Runtime</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light;--ink:#10213d;--muted:#65748b;--line:#dce4ee;--panel:#fff;--page:#f5f7fa;--blue:#2563eb;--blue2:#1d4ed8;--green:#16a34a;--green-bg:#f0faf4;--gray:#8a98ab;--gray-bg:#f5f7fa;--amber:#d97706;--amber-bg:#fff8ed;--red:#c52b37}
*{box-sizing:border-box}body{margin:0;background:var(--page);font-family:Inter,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--ink)}
button,a{font:inherit}.shell{width:min(560px,calc(100vw - 28px));margin:34px auto}.window{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:0 14px 40px rgba(23,40,67,.08);overflow:hidden}
.top{display:flex;align-items:center;gap:14px;padding:22px 24px 18px;border-bottom:1px solid #e8edf3}.logo{width:48px;height:48px;display:block;flex:none}.title{font-size:22px;font-weight:750;line-height:1.15}.subtitle{font-size:13px;color:var(--muted);margin-top:5px}.version{margin-left:auto;color:var(--muted);font-size:13px}
.body{padding:18px}.hero{border:1px solid #e5eaf0;border-radius:14px;padding:24px 20px 18px;background:var(--gray-bg);transition:.2s}.hero.running{background:var(--green-bg)}.hero.recovery{background:var(--amber-bg)}.headline{display:flex;align-items:flex-start;gap:16px}.state-icon{width:45px;height:45px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--gray);font-size:25px;font-weight:800;flex:none}.running .state-icon{background:var(--green)}.recovery .state-icon{background:var(--amber);border-radius:10px}.h1{font-size:23px;font-weight:780;margin:2px 0 5px}.desc{color:#44536a;font-size:14px;line-height:1.65}.service-grid{display:grid;grid-template-columns:1fr 1fr;margin-top:22px;padding-top:18px;border-top:1px solid rgba(122,139,160,.22)}.service{padding:0 16px}.service:first-child{border-right:1px solid rgba(122,139,160,.22);padding-left:4px}.service-name{font-weight:700;font-size:14px}.service-state{font-weight:750;margin-top:7px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--gray);margin-right:7px}.dot.ready{background:var(--green)}.dot.degraded{background:var(--amber)}.service-meta{color:var(--muted);font-size:12px;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:10px;margin-top:14px}.btn{min-height:46px;border-radius:10px;border:1px solid var(--line);background:#f8fafc;color:var(--ink);font-weight:700;cursor:pointer}.btn:hover{background:#eef3f8}.btn:disabled{opacity:.52;cursor:not-allowed}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.primary:hover{background:var(--blue2)}.btn.danger{background:#fff5f5;color:var(--red);border-color:#f3d4d6}.btn.danger:hover{background:#feecec}
.notice{display:none;margin-top:12px;padding:10px 12px;border-radius:9px;font-size:13px;line-height:1.45;background:#eef4ff;color:#234c93}.notice.show{display:block}.notice.error{background:#fff1f2;color:#9f1f2d}.details{margin-top:16px;border-top:1px solid #e7ecf2;padding-top:4px}details summary{cursor:pointer;list-style:none;padding:14px 2px;color:#33445d;font-weight:650;font-size:14px}details summary::-webkit-details-marker{display:none}details summary:before{content:'⌄';display:inline-block;width:25px;color:#596a82}.detail-grid{display:grid;grid-template-columns:128px 1fr;gap:8px 12px;padding:2px 4px 16px;font-size:12px}.k{color:var(--muted)}.v{overflow-wrap:anywhere}.diag{display:none;background:#0f1e31;color:#dbe6f5;border-radius:10px;padding:12px;margin:0 3px 14px;max-height:180px;overflow:auto;white-space:pre-wrap;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.diag.show{display:block}
.foot{display:flex;align-items:center;padding:14px 22px 18px;color:var(--muted);font-size:12px;gap:18px}.foot a{color:#53657d;text-decoration:none}.foot a:hover{color:var(--blue)}.spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:7px}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:520px){.shell{margin:12px auto}.top{padding:18px}.body{padding:12px}.actions{grid-template-columns:1fr}.service-meta{white-space:normal}.detail-grid{grid-template-columns:100px 1fr}}
</style>
</head>
<body><main class="shell"><section class="window">
<header class="top"><img class="logo" src="/favicon.svg" alt=""><div><div class="title">MCP Dev Runtime</div><div class="subtitle">连接 AI 与你的本地开发环境</div></div><div class="version" id="version">v${VERSION}</div></header>
<div class="body">
  <section class="hero" id="hero"><div class="headline"><div class="state-icon" id="stateIcon">•</div><div><div class="h1" id="headline">正在读取状态…</div><div class="desc" id="description">请稍候。</div></div></div>
    <div class="service-grid"><div class="service"><div class="service-name">MCP 服务</div><div class="service-state"><span class="dot" id="mcpDot"></span><span id="mcpState">未知</span></div><div class="service-meta" id="mcpMeta">—</div></div><div class="service"><div class="service-name">Tunnel 连接</div><div class="service-state"><span class="dot" id="tunnelDot"></span><span id="tunnelState">未知</span></div><div class="service-meta" id="tunnelMeta">—</div></div></div>
  </section>
  <div class="actions"><button class="btn primary" id="primary">启动连接</button><button class="btn" id="restart">↻&nbsp; 重新启动</button><button class="btn" id="doctor">⌁&nbsp; 运行诊断</button></div>
  <div class="notice" id="notice"></div>
  <div class="details"><details id="details"><summary>详细信息</summary><div class="detail-grid">
    <div class="k">运行状态</div><div class="v" id="dLifecycle">—</div><div class="k">运行时间</div><div class="v" id="dUptime">—</div><div class="k">配置文件</div><div class="v" id="dConfig">—</div><div class="k">状态目录</div><div class="v" id="dState">—</div><div class="k">日志目录</div><div class="v" id="dLogs">—</div><div class="k">进程</div><div class="v" id="dPids">—</div>
  </div><pre class="diag" id="diag"></pre></details></div>
</div>
<footer class="foot"><a href="https://github.com/dolibali/mcp-dev-runtime/blob/main/docs/CHATGPT_SETUP.zh-CN.md" target="_blank" rel="noreferrer">使用帮助</a><a href="https://github.com/dolibali/mcp-dev-runtime" target="_blank" rel="noreferrer">项目主页</a></footer>
</section></main>
<script nonce="${nonce}">
const TOKEN=${safeToken};
const $=id=>document.getElementById(id);let snapshot=null,busy=false;
const labels={ready:'正常',stopped:'已停止',degraded:'异常',unknown:'未知',disabled:'已禁用'};
function fmtTime(s){if(typeof s!=='number')return '—';s=Math.floor(s);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h?h+' 小时 '+m+' 分钟':m?m+' 分钟':s+' 秒'}
function fmtLatency(v){return typeof v==='number'?'延迟 '+v.toFixed(1)+' ms':'—'}
function setService(prefix,obj,meta){$(prefix+'State').textContent=labels[obj.state]||obj.state;$(prefix+'Dot').className='dot '+(obj.state==='ready'?'ready':obj.state==='degraded'?'degraded':'');$(prefix+'Meta').textContent=meta||'—'}
function render(s){snapshot=s;$('version').textContent='v'+s.version;const hero=$('hero'),icon=$('stateIcon'),primary=$('primary');hero.className='hero '+(s.mode==='running'?'running':s.mode==='recovery'?'recovery':'');
  if(s.mode==='running'){$('headline').textContent='远程连接已开启';$('description').textContent='ChatGPT / Codex 可以通过安全的 Tunnel 连接到这台电脑。';icon.textContent='✓';primary.textContent='■  停止连接';primary.dataset.action='stop';primary.className='btn danger'}
  else if(s.mode==='stopped'){$('headline').textContent='远程连接已关闭';$('description').textContent='这台电脑目前不能通过 MCP Tunnel 被远程访问。';icon.textContent='•';primary.textContent='▶  启动连接';primary.dataset.action='start';primary.className='btn primary'}
  else if(s.mode==='working'){$('headline').textContent=s.lifecycle==='starting'?'正在启动…':'正在停止…';$('description').textContent='状态切换中，请稍候。';icon.textContent='…';primary.textContent='处理中';primary.dataset.action='';primary.className='btn primary'}
  else {$('headline').textContent='连接需要恢复';$('description').textContent='MCP Dev Runtime 当前状态异常；配置仍然保留，可以尝试一键恢复。';icon.textContent='!';primary.textContent='↻  恢复连接';primary.dataset.action='restart';primary.className='btn primary'}
  setService('mcp',s.mcp,s.mcp.url||'—');setService('tunnel',s.tunnel,fmtLatency(s.tunnel.latency_ms));$('dLifecycle').textContent=s.lifecycle;$('dUptime').textContent=fmtTime(s.uptime_seconds);$('dConfig').textContent=s.details.config_file||'默认配置';$('dState').textContent=s.details.state_dir||'—';$('dLogs').textContent=s.details.logs_dir||'—';$('dPids').textContent='Supervisor '+(s.details.supervisor_pid??'—')+' · MCP '+(s.details.mcp_pid??'—')+' · Tunnel '+(s.details.tunnel_pid??'—');updateButtons()}
function updateButtons(){const p=$('primary'),disable=busy||!p.dataset.action;p.disabled=disable;$('restart').disabled=busy||snapshot?.mode==='working';$('doctor').disabled=busy}
function notice(text,error=false){const n=$('notice');n.textContent=text;n.className='notice show'+(error?' error':'');setTimeout(()=>{if(n.textContent===text)n.className='notice'},5000)}
async function api(path,options={}){const headers={'X-MDR-Dashboard-Token':TOKEN,...(options.body?{'Content-Type':'application/json'}:{})};const r=await fetch(path,{...options,headers});if(r.status===403){location.reload();throw new Error('Dashboard session changed')};const data=await r.json().catch(()=>({error:'Invalid dashboard response'}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data}
async function refresh(){try{render(await api('/api/status'))}catch(e){if(e instanceof TypeError){notice('控制面板连接中断，正在自动重试…',true)}else if(e.message!=='Dashboard session changed'){notice('读取状态失败：'+e.message,true)}}}
async function action(name){busy=true;updateButtons();const button=name==='doctor'?$('doctor'):name==='restart'?$('restart'):$('primary'),old=button.textContent;button.innerHTML='<span class="spinner"></span>处理中';try{const result=await api('/api/action',{method:'POST',body:JSON.stringify({action:name})});if(name==='doctor'){const d=$('diag');d.textContent=result.summary||result.output||'诊断完成';d.className='diag show';$('details').open=true;notice(result.ok?'诊断通过':'诊断发现问题',!result.ok)}else notice(result.message||'操作完成');await refresh()}catch(e){notice('操作失败：'+e.message,true);await refresh()}finally{busy=false;button.textContent=old;updateButtons()}}
$('primary').onclick=()=>{const a=$('primary').dataset.action;if(a)action(a)};$('restart').onclick=()=>action('restart');$('doctor').onclick=()=>action('doctor');
refresh();setInterval(()=>{if(!busy)refresh()},5000);
</script></body></html>`;
}

export async function serveDashboard(options: DashboardOptions) {
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  let actionInFlight = false;
  let boundPort = 0;
  let lastActivity = Date.now();
  let closing = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const server = createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (boundPort && req.headers.host !== expectedHost) { res.writeHead(421); res.end(); return; }
      const expectedOrigin = `http://${expectedHost}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=()');
      if (req.method === 'GET' && req.url === '/') {
        lastActivity = Date.now();
        const html = page(token, nonce);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
        });
        res.end(html); return;
      }
      if (req.method === 'GET' && req.url === '/favicon.svg') {
        lastActivity = Date.now();
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(DASHBOARD_ICON_SVG),
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(DASHBOARD_ICON_SVG); return;
      }
      if (!req.url?.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
      if (req.headers['x-mdr-dashboard-token'] !== token) { json(res, 403, { error: 'Dashboard session token is missing or invalid.' }); return; }
      lastActivity = Date.now();
      if (req.method === 'GET' && req.url === '/api/status') { json(res, 200, await statusPayload(options.launch)); return; }
      if (req.method === 'POST' && req.url === '/api/action') {
        if (actionInFlight) { json(res, 409, { error: 'Another dashboard action is still running.' }); return; }
        const body = await requestBody(req), action = body.action;
        if (!['start', 'stop', 'restart', 'doctor'].includes(String(action))) { json(res, 400, { error: 'Unsupported dashboard action.' }); return; }
        actionInFlight = true;
        try {
          if (action === 'doctor') {
            const result = await runCli(['doctor', ...options.doctorArgs, '--json'], 60_000);
            let doctor: any;
            try { doctor = JSON.parse(result.stdout); } catch {}
            json(res, 200, {
              ok: result.ok && doctor?.ok !== false,
              summary: result.ok && doctor?.ok !== false ? 'MCP Dev Runtime doctor: PASS' : (result.stderr.trim() || 'MCP Dev Runtime doctor reported a problem.'),
              output: result.stdout.trim() || result.stderr.trim()
            });
          } else {
            const extra = action === 'start' || action === 'restart' ? ['--background'] : [];
            const result = await runCli([String(action), ...options.managementArgs, ...extra]);
            if (!result.ok) { json(res, 500, { error: result.stderr.trim() || `${action} failed.` }); return; }
            json(res, 200, { ok: true, message: action === 'stop' ? '远程连接已停止。' : action === 'restart' ? 'MCP Dev Runtime 已重新启动。' : '远程连接已启动。' });
          }
        } finally { actionInFlight = false; }
        return;
      }
      res.writeHead(405); res.end();
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard did not expose a TCP listener.');
  boundPort = address.port;
  const url = `http://127.0.0.1:${boundPort}/`;
  console.log(`${NAME} dashboard: ${url}`);
  console.log('Local browser control only; the dashboard exits after 10 minutes without browser activity.');
  if (options.open !== false) await openBrowser(url);
  let idleTimer: NodeJS.Timeout;
  const close = () => {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    server.close(error => error ? rejectClosed(error) : resolveClosed());
  };
  idleTimer = setInterval(() => {
    if (!actionInFlight && Date.now() - lastActivity >= DASHBOARD_IDLE_MS) close();
  }, 30_000);
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await closed;
}

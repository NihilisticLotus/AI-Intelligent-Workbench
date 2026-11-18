// 仅在获准进行收费验收时显式传入 --live。每次使用全新的项目、工作副本与数据目录。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createClaudeAdapter, createCodexAdapter, CLAUDE_SESSION_META,
  type AgentAdapter,
} from '../../packages/adapters/src/index';
import { startGw, WsClient } from '../../packages/gateway/test/helpers';
import { completedReplies } from './handoff-reply';

if (process.argv.slice(2).join(' ') !== '--live') {
  console.log('这是收费补验。获准后仅使用 --live 启动。');
  process.exit(0);
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aic-handoff-acceptance-')));
const project = join(root, 'project');
mkdirSync(project);
const marker = '雾铃' + randomInt(10000, 100000);
const rules = '保留已有成果';
const models = { claude: 'haiku', codex: 'gpt-6-luna' } as const;
const prompts = [
  '在本工作副本用 Write 创建 Level.txt 和 Rules.txt，分别只写一行“' + marker + '”和“' + rules + '”。下一步交给接手者创建 Result.txt。记住识别词，完成后用一句话回复识别词和两个文件名。不要运行命令、启动其他 Agent 或读取其他目录。',
  '接手续做。先用一句话说明目标、已完成的两个文件和下一步，再用文件编辑工具直接新增 Result.txt。只写一行：上轮的识别词，加一个空格，再加“验收通过”。不用运行命令，不改已有文件。',
  '只回复你在切出前记住的关卡识别词。不要调用工具。',
];
const stages = ['claude', 'codex', 'claude'] as const;
const filesByStage = [['Level.txt', 'Rules.txt'], ['Result.txt'], []];
let stage = 0;
let writable = '';
let taskId = '';
let stopping = '';
let nativeSource: string | undefined;
let resumed = false;
let issued = false;
let approvals = 0;
const calls = { claude: 0, codex: 0 };
const observations: Record<string, unknown> = {};
const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
const hash = (file: string) => createHash('sha256').update(readFileSync(join(writable,file))).digest('hex');
class VerificationError extends Error {}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new VerificationError(message);
}
function fail(reason: string) {
  stopping ||= reason;
  if (taskId) void gateway.gw.services.tasks.cancel(taskId).catch(() => {});
}
function exactFile(candidate: string) {
  if (!writable || !candidate) return false;
  const rel = relative(writable, resolve(writable, candidate));
  return !isAbsolute(rel) && filesByStage[stage]?.includes(rel);
}

// 这些上限只作用于本次验收进程。保留 Claude 的原生登录与默认权限边界。
Object.assign(CLAUDE_SESSION_META.claudeCode.options, {
  strictMcpConfig: true, tools: ['Write'], maxBudgetUsd: 0.06, maxTurns: 6,
  env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
});

function guarded(adapter: AgentAdapter): AgentAdapter {
  const agent = adapter.id as keyof typeof models;
  return { ...adapter, async spawn(opts) {
    const host = opts.host;
    const conn = await adapter.spawn({ ...opts, host: { ...host, async requestPermission(req, signal) {
      const op = req.operation;
      const targets = op?.paths.length ? op.paths : [req.detail];
      const edit = op?.tool === 'edit' && !op.command && !op.deletion;
      if (stopping || agent !== stages[stage] || !edit || !targets.length || !targets.every(exactFile)) {
        fail('出现计划外或无法核对目标的工具审批');
        return { outcome: 'cancelled' };
      }
      return host.requestPermission(req, signal);
    } } });
    try {
      const config = conn.config?.();
      check(config?.model === models[agent] && config.models.some(m =>
        m.id === config.model && (agent !== 'claude' || m.name === 'claude-haiku-5-5')), '原生会话未确认指定模型');
      if (agent === 'claude') {
        if (nativeSource === undefined) nativeSource = conn.agentSessionId;
        else resumed = conn.resumed === true && conn.agentSessionId === nativeSource && opts.resume?.agentSessionId === nativeSource;
      }
    } catch (e) { await conn.close(); throw e; }
    const prompt = conn.prompt.bind(conn);
    conn.prompt = async (input, signal) => {
      check(!stopping && !issued && stages[stage] === agent && (stage !== 2 || resumed),
        '阻止额外消息或非原生恢复后的发送');
      issued = true;
      calls[agent]++;
      console.log('发出第 ' + (stage + 1) + ' 轮，模型 ' + models[agent]);
      return prompt(input, signal);
    };
    return conn;
  } };
}

git('init', '-q');
writeFileSync(join(project, 'Brief.txt'), '关卡交接验收\n');
git('add', 'Brief.txt');
git('-c','user.name=验收','-c','user.email=qa@example.invalid','commit','-qm','验收基准');

const gateway = await startGw({ adapters: rt => [guarded(createClaudeAdapter(rt)), guarded(createCodexAdapter(rt))] }, join(root,'data'));
const s = gateway.gw.services;
let ws: WsClient | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  const token = await gateway.pair('交接临时验收');
  ws = await WsClient.connect(gateway.port, token);
  const created = await gateway.api('POST','/projects',{token,body:{name:'Haiku 与 Luna 交接验收',path:project}});
  check(created.status === 201, '临时项目登记失败');
  const task = await s.tasks.create({ projectId:created.json.id, agent:'claude', model:models.claude, effort:'low',
    permission:'ask', prompt:'完成关卡验收并保留原成果', deferPrompt:true });
  taskId = task.id;
  writable = task.workspace?.path ?? '';
  check(writable && writable !== project && !relative(root,writable).startsWith('..') && !isAbsolute(relative(root,writable)),
    '未取得登记在临时目录中的隔离工作副本');

  function checkChanges(names: string[]) {
    const status = execFileSync('git', ['-C', writable, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {encoding:'utf8'});
    const changed = status.split('\0').filter(Boolean).map(entry => entry.slice(3)).sort();
    check(JSON.stringify(changed) === JSON.stringify([...names].sort()), '副本实际改动清单与预期不同');
    check(git('status','--porcelain') === '', '临时原项目发生变化');
  }

  s.events.bus.on(e => {
    if (e.taskId !== taskId) return;
    if (e.type === 'error') fail('工作台报告 ' + e.data.error.code);
    if (e.type === 'tool.end' && !e.data.ok) fail('工具未成功完成');
    if (e.type === 'tool.start' && (stage === 2 || ['execute','delete','fetch'].includes(e.data.kind))) fail('出现计划外工具');
    if (e.type === 'approval.requested') {
      const a = e.data.approval;
      const once = a.options.find(o => o.kind === 'allow_once');
      if (!once || stopping) { fail('无法单次审批'); return; }
      approvals++;
      void ws!.call({ op:'approve', data:{approvalId:a.id,optionId:once.id} }).then(ack => {
        if (!ack.ok) fail('单次审批未生效');
      }).catch(() => fail('单次审批未完成'));
    }
  });

  async function turn(n: number) {
    stage = n;
    issued = false;
    const after = s.events.lastSeq();
    timer = setTimeout(() => fail('单轮超过 120 秒'),120000);
    try {
      const result = await s.tasks.prompt(taskId, prompts[n]!, [],
        n === 1 ? { agent:'codex', model:models.codex, effort:'low' } : undefined);
      check(!result.pendingHandoffId, '交接要求额外确认');
      await s.tasks.idle();
      check(!stopping && issued && s.tasks.get(taskId).status === 'review', stopping || '本轮未正常结束');
      const current = s.db.get<{id:string}>("SELECT id FROM sessions WHERE task_id=? AND agent_id=? AND status='active' ORDER BY rowid DESC LIMIT 1", taskId,stages[n]!);
      check(current, '缺少当前会话');
      return completedReplies(s.db,taskId,current.id,after).join('\n');
    } finally { clearTimeout(timer); }
  }

  const first = await turn(0);
  check(first.includes(marker) && first.includes('Level.txt') && first.includes('Rules.txt'),'Claude 首轮回复未核实');
  check(readFileSync(join(writable,'Level.txt'),'utf8').trim() === marker &&
    readFileSync(join(writable,'Rules.txt'),'utf8').trim() === rules && !existsSync(join(writable,'Result.txt')),
    'Claude 首轮文件与预期不同');
  const sourceHashes = [hash('Level.txt'),hash('Rules.txt')];
  checkChanges(['Level.txt','Rules.txt']);
  observations.claudeSource = true;
  const next = await turn(1);
  const receipt = s.db.get<{id:string;state:string;level:string;quality_json:string}>('SELECT id,state,level,quality_json FROM handoffs WHERE task_id=? ORDER BY ordinal DESC LIMIT 1', taskId);
  check(receipt?.state === 'sent' && JSON.parse(receipt.quality_json).coveragePassed, '缺少覆盖通过的成功收据');
  check(next.includes('Level.txt') && next.includes('Rules.txt') && next.includes('Result.txt'),'Codex 复述未核实');
  check(readFileSync(join(writable,'Result.txt'),'utf8').trim() === marker+' 验收通过','接手成果内容不符');
  check(sourceHashes[0] === hash('Level.txt') && sourceHashes[1] === hash('Rules.txt'),'交接后原成果发生变化');
  checkChanges(['Level.txt','Rules.txt','Result.txt']);
  observations.codexHandoff = receipt.level;
  observations.sourceHashesPreserved = true;
  const resultHash = hash('Result.txt');
  issued = true; // 恢复本身不得再发模型请求。
  const back = await s.tasks.returnHandoff(taskId,receipt.id);
  check('level' in back && back.level === 'H1' && resumed, '未能原生切回原来的 Claude 会话');
  observations.nativeH1 = true;
  const last = await turn(2);
  check(last.includes(marker), '切回后的 Claude 未复述原识别词');
  check(sourceHashes[0] === hash('Level.txt') && sourceHashes[1] === hash('Rules.txt') && resultHash === hash('Result.txt'), '切回后文件发生变化');
  checkChanges(['Level.txt','Rules.txt','Result.txt']);
  observations.recalled = true;
} catch (error) {
  // 仅输出固定断言或已规范化的错误码；不导出第三方回复、凭据或会话编号。
  const native = error as {body?:{code?:string};code?:string;message?:string};
  const code = native.body?.code ?? native.code;
  stopping ||= error instanceof VerificationError ? error.message
    : typeof code === 'string' && /^[a-zA-Z0-9_.-]+$/.test(code) ? code : '验收发生异常';
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    if (stopping && taskId) { await s.tasks.cancel(taskId); await s.tasks.idle(); }
    const usage = s.db.all(`SELECT s.agent_id AS agent, json_extract(u.usage_json,'$.totalTokens') AS tokens
      FROM turn_usage u JOIN sessions s ON s.id=u.session_id WHERE u.task_id=? ORDER BY u.at,u.rowid`,taskId);
    const costs = s.db.all(`SELECT s.agent_id AS agent,json_extract(e.payload,'$.cost.amount') AS amount,json_extract(e.payload,'$.cost.currency') AS currency
      FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.task_id=? AND e.type='session.usage' AND e.replay=0 AND json_extract(e.payload,'$.cost') IS NOT NULL ORDER BY e.seq`,taskId);
    const originalClean = git('status','--porcelain') === '';
    if (!originalClean) { stopping ||= '临时原项目发生变化'; process.exitCode = 1; }
    console.log(JSON.stringify({临时目录:root,提示词:calls,单次操作审批:approvals,核对:observations,原项目干净:originalClean,用量:usage,原生费用报告:costs,停止原因:stopping || null}));
  } finally { await ws?.close(); await gateway.gw.close(); }
}

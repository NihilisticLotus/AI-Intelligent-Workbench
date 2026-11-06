// 演示 Agent：不需要登录、不碰磁盘，按真实 Agent 的节奏产生思考、流式回复、工具调用、计划和审批。
// 用于在没有任何真实 Agent 时走通整个界面，也用作接口契约测试的对手方。
import type { PermissionLevel } from '@aic/protocol';
import { AbortError, newId, sleep } from './util';
import type {
  AgentAdapter, AgentCaps, AgentConnection, ModelInfo, PermissionRequest, SessionHost, SpawnOptions, StopReason,
} from './types';

export const FAKE_MODELS: ModelInfo[] = [
  { id: 'demo-fast', name: '演示-快', contextWindow: 200_000 },
  { id: 'demo-deep', name: '演示-深思', contextWindow: 1_000_000 },
];
export const FAKE_EFFORTS = ['低', '中', '高'];

/** 示例文件：贴合 Unity 游戏项目 */
const FILE_PLAYER = 'Assets/Scripts/Player/PlayerController.cs';
const FILE_CONFIG = 'Assets/Settings/PlayerTuning.asset';
const COMMAND = 'Unity.exe -batchmode -projectPath . -runTests -testPlatform EditMode -testResults Temp/results.xml';

export interface FakeAgentOptions {
  /** 节奏倍率：1 = 真实节奏，0 = 测试用（不等待） */
  speed?: number;
}

const CAPS: AgentCaps = {
  loadSession: false, resume: false, list: false, close: true, fork: false,
  modelSwitch: 'configOption', effortOptions: FAKE_EFFORTS, thoughts: true,
  modes: [{ id: 'default', name: '默认' }],
  prompt: { image: false, audio: false, embeddedContext: false },
  mcp: { http: false, sse: false },
  extensions: [],
};

export function createFakeAdapter(opts: FakeAgentOptions = {}): AgentAdapter {
  const speed = opts.speed ?? 1;
  return {
    id: 'fake',
    displayName: '演示 Agent（无需登录）',
    authMethods: ['none'],
    async detect() { return { installed: true, version: '1.0.0', enginePath: null, loggedIn: true, message: '内置的演示 Agent，只模拟过程，不会修改你的文件', adapterVersion: '1.0.0', engineVersion: null, engineSource: 'bundled' as const, engineLocation: '内置', verified: true, authMethods: [], loginCheck: 'none' as const, checkedAt: Date.now() }; },
    async login() { /* 无需登录 */ },
    buildEnv() { return {}; },
    async listModels() { return FAKE_MODELS; },
    async listEfforts() { return FAKE_EFFORTS; },
    async spawn(o: SpawnOptions) { return new FakeConnection(o, speed); },
    async probeCapabilities() { return CAPS; },
    mapPermissionLevel(level) { return { modeId: level === 'readonly' ? 'plan' : 'default' }; },
    contextWindowOf(id) { return FAKE_MODELS.find((m) => m.id === id)?.contextWindow ?? undefined; },
  };
}

class FakeConnection implements AgentConnection {
  readonly agentSessionId = newId('fake');
  private model: string;
  private effort: string;
  private permission: PermissionLevel;
  private host: SessionHost;
  private turn = 0;

  constructor(o: SpawnOptions, private speed: number) {
    this.model = o.model ?? FAKE_MODELS[0]!.id;
    this.effort = o.effort ?? '中';
    this.permission = o.permission;
    this.host = o.host;
  }

  async setConfig(cfg: { model?: string; effort?: string }) {
    if (cfg.model) this.model = cfg.model;
    if (cfg.effort) this.effort = cfg.effort;
    this.host.update({ kind: 'config', model: this.model, effort: this.effort });
  }
  async setPermission(level: PermissionLevel) { this.permission = level; }
  async close() { /* 无进程需要回收 */ }

  /** 等待：深思模型更慢，倍率为 0 时只让出事件循环 */
  private wait(ms: number, signal: AbortSignal) {
    const k = this.model === 'demo-deep' ? 1.6 : 1;
    return sleep(Math.round(ms * k * this.speed), signal);
  }

  private async stream(kind: 'thought' | 'message', messageId: string, text: string, signal: AbortSignal) {
    // 按 2～6 个字一段推送，模拟真实的流式输出
    for (let i = 0; i < text.length;) {
      const n = 2 + ((i * 7) % 5);
      this.host.update({ kind, messageId, text: text.slice(i, i + n) });
      i += n;
      await this.wait(35, signal);
    }
  }

  private async say(text: string, signal: AbortSignal) {
    const id = newId('m');
    await this.stream('message', id, text, signal);
    this.host.update({ kind: 'message_done', messageId: id });
  }

  private async tool(kind: 'read' | 'search' | 'edit' | 'execute', title: string, target: string, run: (toolId: string) => Promise<{ ok: boolean; summary: string }>, signal: AbortSignal) {
    const toolId = newId('tool');
    this.host.update({ kind: 'tool_start', toolId, toolKind: kind, title, target });
    try {
      const r = await run(toolId);
      this.host.update({ kind: 'tool_end', toolId, ok: r.ok, summary: r.summary });
      return r;
    } catch (e) {
      // 取消时也要把工具收尾，界面不会留下“一直在转”的卡片
      this.host.update({ kind: 'tool_end', toolId, ok: false, summary: e instanceof AbortError || signal.aborted ? '已取消' : '出错' });
      throw e;
    }
  }

  async prompt(text: string, signal: AbortSignal): Promise<{ stopReason: StopReason }> {
    this.turn++;
    try {
      await this.run(text, signal);
      return { stopReason: 'end_turn' };
    } catch (e) {
      if (e instanceof AbortError || signal.aborted) return { stopReason: 'cancelled' };
      throw e;
    }
  }

  private async run(text: string, signal: AbortSignal) {
    const brief = text.length > 24 ? `${text.slice(0, 24)}……` : text;
    // 1. 思考：强度越高想得越多
    const thoughts = [
      `用户的要求是“${brief}”。`,
      '先看玩家控制脚本里跳跃相关的参数，',
      '再确认调参资源里有没有覆盖同名字段，',
      '改完要跑一遍 EditMode 测试，避免影响已有的手感测试。',
      '注意不要改动输入系统的绑定，只调数值。',
      '如果测试失败，先回退参数再分析原因。',
    ];
    const n = this.effort === '低' ? 2 : this.effort === '高' ? 6 : 4;
    const thoughtId = newId('th');
    for (const t of thoughts.slice(0, n)) {
      await this.stream('thought', thoughtId, t, signal);
      await this.wait(120, signal);
    }

    // 2. 开场回复
    await this.say(this.turn === 1 ? '好的，我先看一下项目里和这件事相关的代码。' : '收到，我接着上次的改动继续。', signal);

    // 3. 读文件、搜索
    await this.tool('read', '读取文件', FILE_PLAYER, async () => { await this.wait(400, signal); return { ok: true, summary: '读取 182 行' }; }, signal);
    await this.tool('search', '搜索 jumpForce', 'Assets/Scripts', async (id) => {
      await this.wait(300, signal);
      this.host.update({ kind: 'tool_output', toolId: id, text: `${FILE_PLAYER}:41  public float jumpForce = 7.5f;\n${FILE_PLAYER}:118  rb.AddForce(Vector3.up * jumpForce, ForceMode.Impulse);\n${FILE_CONFIG}:12  jumpForce: 7.5` });
      return { ok: true, summary: '找到 3 处' };
    }, signal);

    this.host.update({ kind: 'plan', items: [
      { text: '读取玩家控制脚本', status: 'completed' },
      { text: '调整跳跃参数', status: 'in_progress' },
      { text: '运行 EditMode 测试', status: 'pending' },
    ] });

    // 4. 修改文件（只读权限下拒绝）
    if (this.permission === 'readonly') {
      await this.tool('edit', '修改文件', FILE_PLAYER, async () => ({ ok: false, summary: '只读权限，不允许修改文件' }), signal);
      this.host.update({ kind: 'plan', items: [
        { text: '读取玩家控制脚本', status: 'completed' },
        { text: '调整跳跃参数', status: 'pending' },
        { text: '运行 EditMode 测试', status: 'pending' },
      ] });
      await this.say(`当前任务是只读权限，我不能修改文件，也不能执行命令。建议的改动是：把 ${FILE_PLAYER} 第 41 行的 jumpForce 从 7.5 调到 8.2，并在 ${FILE_CONFIG} 里同步。需要我动手的话，请把权限改成“需审批”或更高。`, signal);
      return;
    }
    // 需审批：修改文件前也要问（design.md 9.1）。工作区内自动、全自动由 Gateway 的权限层直接放行
    if (this.permission === 'ask') {
      const editReq: PermissionRequest = {
        toolId: newId('tool'),
        title: '演示 Agent 请求修改文件',
        reason: '把跳跃力度从 7.5 调到 8.2，并加上土狼时间',
        detail: FILE_PLAYER,
        cwd: null,
        options: [
          { id: 'allow', label: '允许一次', kind: 'allow_once' },
          { id: 'reject', label: '拒绝', kind: 'reject_once' },
        ],
      };
      const out = await this.host.requestPermission(editReq, signal);
      if (out.outcome === 'cancelled') throw new AbortError();
      const opt = editReq.options.find((o) => o.id === out.optionId);
      if (!opt || !opt.kind.startsWith('allow')) {
        const why = out.note ? `（你的理由：${out.note}）` : '';
        await this.say(`好的，不改这个文件${why}。建议的改动是：把 ${FILE_PLAYER} 第 41 行的 jumpForce 从 7.5 调到 8.2；你确认后告诉我，我再动手。`, signal);
        return;
      }
    }
    await this.tool('edit', '修改文件', FILE_PLAYER, async (id) => {
      await this.wait(500, signal);
      this.host.update({ kind: 'tool_output', toolId: id, text: '@@ -41 +41,3 @@\n-    public float jumpForce = 7.5f;\n+    [Tooltip("起跳力度")]\n+    public float jumpForce = 8.2f;\n+    public float coyoteTime = 0.12f;' });
      return { ok: true, summary: '+3 −1' };
    }, signal);

    this.host.update({ kind: 'plan', items: [
      { text: '读取玩家控制脚本', status: 'completed' },
      { text: '调整跳跃参数', status: 'completed' },
      { text: '运行 EditMode 测试', status: 'in_progress' },
    ] });
    await this.say('参数改好了，接下来运行 EditMode 测试确认没有影响手感测试。', signal);

    // 5. 执行命令：需审批时等用户决定；全自动 / 工作区内自动由 Gateway 的权限层直接放行
    const toolId = newId('tool');
    this.host.update({ kind: 'tool_start', toolId, toolKind: 'execute', title: '执行命令', target: COMMAND });
    let decision: { allowed: boolean; note?: string };
    if (this.permission === 'full') {
      decision = { allowed: true };
    } else {
      const req: PermissionRequest = {
        toolId,
        title: '演示 Agent 请求执行命令',
        reason: '运行 EditMode 测试，确认跳跃参数的修改没有破坏已有测试',
        detail: COMMAND,
        cwd: null,
        options: [
          // “总是允许”要配合规则功能（后续步骤）才有意义，1.1 不提供这个选项
          { id: 'allow', label: '允许一次', kind: 'allow_once' },
          { id: 'reject', label: '拒绝', kind: 'reject_once' },
        ],
      };
      let out;
      try { out = await this.host.requestPermission(req, signal); }
      catch (e) { this.host.update({ kind: 'tool_end', toolId, ok: false, summary: '已取消' }); throw e; }
      if (out.outcome === 'cancelled') {
        this.host.update({ kind: 'tool_end', toolId, ok: false, summary: '已取消' });
        throw new AbortError();
      }
      const opt = req.options.find((o) => o.id === out.optionId);
      decision = { allowed: !!opt && opt.kind.startsWith('allow'), ...(out.note ? { note: out.note } : {}) };
    }

    if (!decision.allowed) {
      this.host.update({ kind: 'tool_end', toolId, ok: false, summary: '用户拒绝执行', rejected: true });
      this.host.update({ kind: 'plan', items: [
        { text: '读取玩家控制脚本', status: 'completed' },
        { text: '调整跳跃参数', status: 'completed' },
        { text: '运行 EditMode 测试', status: 'pending' },
      ] });
      const why = decision.note ? `（你的理由：${decision.note}）` : '';
      await this.say(`好的，这条命令我不执行了${why}。换个方式：你可以在 Unity 编辑器里打开 Window → General → Test Runner，选 EditMode 后点 Run All，结果告诉我就行。参数的修改已经完成，可以先在场景里试跳看看手感。`, signal);
      return;
    }

    try {
      await this.wait(600, signal);
      this.host.update({ kind: 'tool_output', toolId, text: '正在运行 EditMode 测试……\nPlayerJumpTests  6/6 通过\nPlayerMoveTests  6/6 通过\n共 12 项，全部通过（用时 8.4 秒）' });
      await this.wait(300, signal);
    } catch (e) {
      this.host.update({ kind: 'tool_end', toolId, ok: false, summary: '已取消' });
      throw e;
    }
    this.host.update({ kind: 'tool_end', toolId, ok: true, summary: '12 项测试全部通过' });
    this.host.update({ kind: 'plan', items: [
      { text: '读取玩家控制脚本', status: 'completed' },
      { text: '调整跳跃参数', status: 'completed' },
      { text: '运行 EditMode 测试', status: 'completed' },
    ] });
    await this.say(`完成了。总结一下：\n1. ${FILE_PLAYER}：jumpForce 从 7.5 调到 8.2，新增 coyoteTime = 0.12（离开平台后 0.12 秒内仍可起跳）。\n2. EditMode 测试 12 项全部通过。\n（这是演示 Agent，以上改动只是模拟，没有真的修改文件。）`, signal);
  }
}

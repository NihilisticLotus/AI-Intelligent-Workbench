// Gateway 自有循环：driver 不能自动批准 / 调用工具；所有续传以已提交的会话为准。
import {
  IndependentAssistantMessage, IndependentToolMessage, type IndependentModelDriver,
  type IndependentToolDriver, type IndependentTurnRecord, type IndependentTurnStop,
} from '@aic/protocol';
import { Errors } from '../util';
import { IndependentConversationStore } from './conversation';
import { ModelTransportError } from './model-http';

/** 隔离迟到返回，不将 AbortSignal 当作底层网络 / 进程已收尾的证明。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error: unknown) => {
      signal.removeEventListener('abort', abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}

export class IndependentTurnEngine {
  private active = new Map<string, { abort: AbortController; completion: Promise<IndependentTurnRecord> }>();
  private closed = false;
  constructor(private store: IndependentConversationStore, private model: IndependentModelDriver, private tools: IndependentToolDriver) {}

  run(id: string, externalSignal?: AbortSignal): Promise<IndependentTurnRecord> {
    if (this.closed) return Promise.reject(Errors.invalidState('独立执行循环已关闭'));
    const owner = this.store.acquire(id); const turn = this.store.get(id); const abort = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort('timed_out'), Math.max(0, turn.createdAt + turn.limits.timeoutMs - Date.now()));
    const signal = AbortSignal.any([abort.signal, deadline.signal, ...(externalSignal ? [externalSignal] : [])]);
    const isStopped = () => { if (Date.now() >= turn.createdAt + turn.limits.timeoutMs) deadline.abort('timed_out'); return signal.aborted; };
    const stopped = (): IndependentTurnStop => deadline.signal.aborted ? 'timed_out' : abort.signal.reason === 'shutdown' ? 'interrupted' : 'cancelled';
    // 先登记活动项，再允许 driver 回调；同步触发关闭也必须能找到本回合并等待收尾。
    const completion = Promise.resolve().then(() => this.loop(id, owner, signal, isStopped, stopped))
      .finally(() => { clearTimeout(timer); this.active.delete(id); });
    this.active.set(id, { abort, completion }); return completion;
  }

  private async loop(id: string, owner: string, signal: AbortSignal, isStopped: () => boolean, stopped: () => IndependentTurnStop): Promise<IndependentTurnRecord> {
    const finish = (stop: IndependentTurnStop) => this.store.finish(id, owner, stop);
    const check = async () => {
      if (isStopped()) return false;
      try { await abortable(Promise.resolve(this.model.checkBinding(this.store.get(id).binding)), signal); return !signal.aborted; }
      catch { return false; }
    };
    for (;;) {
      if (isStopped()) return finish(stopped());
      let turn = this.store.get(id); const pending = this.store.pending(id);
      if (pending.length) {
        if (turn.outputTokens === null) return finish('usage_unknown');
        if (turn.outputTokens >= turn.limits.maxOutputTokens) return finish('output_limit');
        for (const _ of pending) {
          if (isStopped()) return finish(stopped());
          if (!await check()) return finish(signal.aborted ? stopped() : 'configuration_changed');
          if (isStopped()) return finish(stopped());
          turn = this.store.get(id);
          if (turn.toolCalls >= turn.limits.maxToolCalls) return finish('tool_limit');
          const call = this.store.claimTool(id, owner);
          let result: IndependentToolMessage;
          try {
            // 必须等待工具真正收尾再结束回合，避免下一回合与仍在运行的旧命令重叠。
            result = IndependentToolMessage.parse(await this.tools.execute(call,
              { taskId: turn.taskId, sessionId: turn.sessionId, turnId: id }, signal));
            if (result.callId !== call.id || result.name !== call.name) throw Errors.invalidState('工具结果身份不一致');
          } catch {
            if (signal.aborted) return finish(stopped());
            // 未知执行异常可能已有副作用，不能当作普通工具错误继续或自动重试。
            this.store.tool(id, owner, { role: 'tool', callId: call.id, name: call.name,
              text: '工具没有可靠返回结果，请核对实际副作用后再继续；不会自动重放。', outcome: 'interrupted' });
            return finish('tool_error');
          }
          if (isStopped()) return finish(stopped());
          this.store.tool(id, owner, result);
          if (result.outcome === 'interrupted') return finish('tool_error');
        }
        continue;
      }
      if (turn.modelCalls >= turn.limits.maxModelCalls) return finish('model_limit');
      if (turn.outputTokens === null) return finish('usage_unknown');
      if (turn.outputTokens >= turn.limits.maxOutputTokens) return finish('output_limit');
      const context = this.store.context(id);
      if (Buffer.byteLength(JSON.stringify(context)) > turn.limits.maxContextBytes || !this.store.canRequest(id)) return finish('context_limit');
      if (!await check()) return finish(signal.aborted ? stopped() : 'configuration_changed');
      if (isStopped()) return finish(stopped());
      turn = this.store.claimModel(id, owner);
      let reply: IndependentAssistantMessage;
      try {
        reply = IndependentAssistantMessage.parse(await abortable(this.model.complete({ binding: turn.binding, ...context,
          maxOutputTokens: turn.limits.maxOutputTokens - turn.outputTokens! }, signal), signal));
      } catch (error) {
        // 正式传输可等待实际连接收尾，不能在 abortable 先返回时释放会话运行资格。
        await this.model.waitForIdle?.(turn.binding);
        if (signal.aborted) return finish(stopped());
        try { await this.model.checkBinding(turn.binding); } catch { return finish('configuration_changed'); }
        if (error instanceof ModelTransportError && error.reason === 'context') return finish('context_limit');
        if (error instanceof ModelTransportError && error.reason === 'budget') return finish('request_budget');
        return finish('model_error');
      }
      if (isStopped()) return finish(stopped());
      // DB 错误必须向宿主传播；不能被网络异常处理吞掉后标为成功。
      turn = this.store.assistant(id, owner, reply);
      if (turn.outputTokens !== null && turn.outputTokens > turn.limits.maxOutputTokens) return finish('output_limit');
      if (reply.stopReason === 'complete') return finish('completed');
      if (reply.stopReason === 'error') return finish('model_error');
      if (reply.stopReason === 'cancelled') return finish('cancelled');
      if (reply.stopReason === 'length') return finish('output_limit');
    }
  }

  async close() {
    this.closed = true; const active = [...this.active.values()];
    for (const item of active) item.abort.abort('shutdown');
    const results = await Promise.allSettled(active.map((item) => item.completion));
    if (results.some((r) => r.status === 'rejected')) throw Errors.internal('独立循环收尾时持久化失败，请在恢复前核对未定工具');
  }
}

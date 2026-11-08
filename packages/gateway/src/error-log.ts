import { redact } from '@aic/adapters';

/** 终端只记录脱敏后的异常文本，不展开可能附带请求、凭据或附件的对象字段。 */
export function errorLogText(error: unknown, secrets: readonly string[] = []): string {
  const text = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}`
    : typeof error === 'string' ? error : '非 Error 异常（已省略附带数据）';
  return redact(text, secrets);
}

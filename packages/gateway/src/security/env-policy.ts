// 受控子进程环境变量白名单构造器：供独立命令、MCP 与受控浏览器统一复用。
import path from 'node:path';

/** 允许子进程继承的最小系统运行环境变量（统一转为大写键） */
export const DEFAULT_ALLOWED_SYSTEM_ENV = [
  'SYSTEMROOT',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'LANG',
  'LC_ALL',
] as const;

/** 由隔离目录接管、不允许从宿主继承或被外部覆盖的目录变量（大写键） */
export const ISOLATED_HOME_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'PSMODULEANALYSISCACHEPATH',
]);

/** 不允许通过 extraVars 覆盖的系统可执行路径查找键（防劫持命令解析） */
const PROTECTED_SYSTEM_EXEC_KEYS = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'PATH',
  'PATHEXT',
  'COMSPEC',
]);

/** 进程注入勾子、敏感凭据与调试覆盖变量：禁止出现在受控子进程的扩展允许项或注入项中 */
const FORBIDDEN_EXACT_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'RUBYOPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'IFS',
  'ELECTRON_RUN_AS_NODE',
  'SSLKEYLOGFILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'AWS_ACCESS_KEY_ID',
  'AZURE_OPENAI_API_KEY',
  'DEFAULT_AUTH_REQUEST',
  'MODEL_PROVIDER',
]);

const FORBIDDEN_PREFIXES = [
  'AIC_',
  'OPENAI_',
  'ANTHROPIC_',
  'GEMINI_',
  'GOOGLE_API_',
  'AZURE_OPENAI_',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'AWS_SECRET',
  'AWS_SESSION_TOKEN',
  'CLAUDE_',
  'CODEX_',
  'CODEBUDDY_',
  'ZCODE_',
  'ANTIGRAVITY_',
  'AGY_',
];

export interface IsolatedSubprocessEnvOptions {
  /** 为该子进程准备的隔离临时根目录，HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP 均限制于此 */
  home: string;
  /** 额外允许从宿主 source 继承的非敏感变量名（如特定 CLI 所需只读标志） */
  extraAllowed?: readonly string[];
  /** 显式附加给子进程的受控变量；禁止 AIC_* 与进程注入勾子 */
  extraVars?: Readonly<Record<string, string>>;
  /** 宿主环境变量来源，默认 process.env（便于单测隔离输入） */
  source?: NodeJS.ProcessEnv;
}

/** 判定环境变量名是否属于禁止暴露给受控子进程的内部/注入/敏感键。 */
export function isForbiddenSubprocessEnvKey(name: string): boolean {
  const trimmed = name.trim();
  const upper = trimmed.toUpperCase();
  if (!upper || trimmed !== name || /[=\0\r\n\s]/.test(name)) return true;
  return FORBIDDEN_EXACT_KEYS.has(upper) || FORBIDDEN_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * 构造受控子进程的隔离环境变量集合：
 * 默认仅继承最小系统项 + 指定隔离目录，剥离 API Key、代理认证、Node hooks 与 Gateway 私有变量。
 */
export function buildIsolatedSubprocessEnv(options: IsolatedSubprocessEnvOptions): Record<string, string> {
  const { home, extraAllowed = [], extraVars = {}, source = process.env } = options;
  if (!home || !home.trim()) throw new Error('受控子进程缺少隔离目录 home');

  const allowed = new Set<string>(DEFAULT_ALLOWED_SYSTEM_ENV);
  for (const key of extraAllowed) {
    const trimmed = key.trim();
    const upper = trimmed.toUpperCase();
    if (!trimmed || trimmed !== key || isForbiddenSubprocessEnvKey(key) || ISOLATED_HOME_ENV_KEYS.has(upper)) {
      throw new Error(`受控子进程白名单不允许放行环境变量：${key}`);
    }
    allowed.add(upper);
  }

  const extraValidated: Record<string, string> = {};
  const extraUpperSeen = new Set<string>();
  for (const [key, value] of Object.entries(extraVars)) {
    const trimmed = key.trim();
    const upper = trimmed.toUpperCase();
    if (
      !trimmed ||
      trimmed !== key ||
      isForbiddenSubprocessEnvKey(key) ||
      ISOLATED_HOME_ENV_KEYS.has(upper) ||
      PROTECTED_SYSTEM_EXEC_KEYS.has(upper) ||
      extraUpperSeen.has(upper)
    ) {
      throw new Error(`不允许向受控子进程注入受限或冲突环境变量：${key}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new Error(`受控子进程环境变量值无效：${key}`);
    }
    extraUpperSeen.add(upper);
    extraValidated[key] = value;
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value !== undefined && allowed.has(upper) && !extraUpperSeen.has(upper)) result[upper] = value;
  }

  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'roaming'),
    // Windows 已知目录可能为空，显式把 PowerShell 模块缓存限制在本次私有目录，避免相对路径落入项目。
    PSModuleAnalysisCachePath: path.join(home, 'local', 'ModuleAnalysisCache'),
    LOCALAPPDATA: path.join(home, 'local'),
    TEMP: path.join(home, 'temp'),
    TMP: path.join(home, 'temp'),
    ...extraValidated,
  };
}

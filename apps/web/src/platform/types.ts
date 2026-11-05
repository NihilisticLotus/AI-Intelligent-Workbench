// Platform：和运行环境相关的能力。界面代码只通过这个接口使用它们。
// 现在只有浏览器实现；以后桌面软件（Tauri）和手机应用各自提供一份实现，界面代码不用改。

export interface PickedFolder {
  /** Gateway 返回的不透明路径，原样交回 POST /projects，客户端不解析、不拼接 */
  path: string;
  /** 文件夹显示名（用作项目名的默认值） */
  name: string;
  isGit: boolean;
}

export interface SecureStorage {
  /**
   * 是否真的是系统级安全存储。浏览器版不是：令牌在 HttpOnly Cookie 里，这里只放设备密钥
   * （按“源”含端口隔离的本地存储；单有密钥或单有 Cookie 都无法通过鉴权）
   */
  readonly secure: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Platform {
  readonly kind: 'browser' | 'desktop' | 'mobile';
  /** Gateway 基础地址；'' 表示和页面同源 */
  readonly baseUrl: string;
  /**
   * 配对时向 Gateway 要哪种凭据（PairingCompleteBody.tokenDelivery）：
   * - cookie：浏览器。令牌进 HttpOnly Cookie，响应里给设备密钥，存进 secureStorage；
   * - bearer：桌面 / 手机应用。响应里给令牌，存进 secureStorage，之后用 Authorization: Bearer。
   * 凭据的读写、请求头和 WebSocket 子协议由 api/credentials.ts 统一处理，界面代码不碰。
   */
  readonly tokenDelivery: 'cookie' | 'bearer';

  /** 系统通知（审批到来等）；没有权限时静默忽略 */
  notify(opts: { title: string; body: string; tag?: string; onClick?: () => void }): Promise<void>;
  /** 选文件夹：浏览器版打开基于 /fs/browse 的对话框；桌面版可以用系统对话框。取消时返回 null */
  pickFolder(): Promise<PickedFolder | null>;
  /** 在 IDE 中打开 */
  readonly canOpenInIde: boolean;
  openInIde(target: { projectId: string; taskId?: string }): Promise<void>;
  /** 本机偏好设置（同步读写，界面启动时就要用） */
  prefs: { get(key: string): string | null; set(key: string, value: string): void };
  secureStorage: SecureStorage;
}

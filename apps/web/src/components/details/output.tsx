import { useState } from 'react';
import type { TaskFile } from '@aic/protocol';
export function OutputDetails({ files, error }: { files: TaskFile[] | null; error: string | null }) {
  const [count, setCount] = useState(5);
  return <>{files ? <>{error ? <p className="d-note" role="alert">刷新失败，以下为上次读取的文件记录：{error}</p> : null}<ul className="d-list output-list">{files.slice(0,count).map((f) => <li key={`${f.sessionId}:${f.path}`}><span className="t" title={f.path}><span>{f.name}</span><small>{f.directory}</small></span><span className="r">{f.created ? '新建' : f.added === null && f.removed === null ? '行数未报告' : <><span className="add">+{f.added ?? '未报告'}</span> <span className="del">−{f.removed ?? '未报告'}</span></>}</span></li>)}</ul>
    {!files.length ? <p className="d-note">尚无已完成的文件修改记录。</p> : null}
    {files.length > count ? <button type="button" className="detail-link" onClick={() => setCount(files.length)}>再显示 {files.length-count} 个</button> : null}</> : <p className="d-note" role="status">{error ?? '正在读取文件记录…'}</p>}
    <p className="d-note">来自 Agent 的工具记录，工作副本的实际改动将在之后的版本提供。按会话合并同一路径；行数为工具报告的修改量。</p></>;
}

// 动画帧和定时器竞争，遮挡窗口时也必须刷新；同一批入队只执行一次。
export function createFlusher(o: { raf: (run: () => void) => unknown; setTimeout: (run: () => void, ms: number) => unknown; visibility: () => boolean; flush: () => void }) {
  // 浏览器原生计时器不能被当作配置对象的方法调用（会抛 Illegal invocation）。
  const {raf,setTimeout:later,visibility,flush}=o;
  let scheduled=false;
  return () => {
    if(scheduled)return;scheduled=true;let done=false;
    const run=()=>{if(done)return;done=true;scheduled=false;flush();};
    if(visibility())raf(run);later(run,visibility()?100:16);
  };
}

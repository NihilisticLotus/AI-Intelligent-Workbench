import { setPref, usePref } from '../state/prefs';

export function WorkViewSwitch() {
  const view = usePref('workView');
  return <div className="work-view-switch" role="group" aria-label="任务视图">
    <button type="button" aria-pressed={view === 'chat'} onClick={() => setPref('workView', 'chat')}>对话</button>
    <button type="button" aria-pressed={view === 'board'} onClick={() => setPref('workView', 'board')}>看板</button>
  </div>;
}

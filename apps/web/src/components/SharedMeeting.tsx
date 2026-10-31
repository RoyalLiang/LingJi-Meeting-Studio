import type { Minutes } from "../model";
import { Brand } from './Brand';
import { MinutesTree, DecisionMinutes } from './MinutesViews';
import './SharedMeeting.css';

export interface SharedMeetingData { title: string; minutes: Minutes | null;  }

export function SharedMeeting({ data, error }: { data?: SharedMeetingData; error: string }) {
  return <main className="shared-page glass shared-meeting"><Brand/><p className="kicker">只读会议分享</p>{error ? <p role="alert">{error}</p> : !data ? <p role="status">正在读取分享…</p> : <>
    <header className="shared-meeting-heading"><h1>{data.title}</h1></header>
    {data.minutes ? <>
      <MinutesTree minutes={data.minutes} cite={()=>{}}/>
      {Boolean(data.minutes.decisions?.length) && <section className="shared-meeting-section"><h2>关键决策</h2><DecisionMinutes minutes={data.minutes} cite={()=>{}}/></section>}
      {data.minutes.actions.length > 0 && <section className="shared-meeting-section"><h2>行动事项</h2><ul>{data.minutes.actions.map((action, index) => <li key={index}><p>{action.text}</p>{(action.owner || action.due) && <small>{[action.owner, action.due].filter(Boolean).join(' · ')}</small>}</li>)}</ul></section>}
    </> : <p className="muted">纪要生成后会显示在这里。</p>}
  </>}</main>;
}

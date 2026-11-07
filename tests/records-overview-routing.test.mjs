import test from 'node:test';
import assert from 'node:assert/strict';
import {compileMeetingOverview} from '../packages/records/src/meeting-minutes-overview.mjs';
const fixture=()=>({title:'架构讨论',topics:Array.from({length:4},(_,i)=>({id:`t${i}`,title:`讨论主题 ${i+1}`,summary:'本主题的明确内容与边界'})),sections:[],highlights:[],actions:[],decisions:[],visuals:[],tables:[]});
const endpoint=(end,nodes)=>{const n=nodes.find(n=>n.id===end.attached_object.id),p=end.attached_object.position;return{x:n.x+n.width*p.x,y:n.y+n.height*p.y};};
function crosses(a,b,r){
  let min=0,max=1;
  for(const [start,delta,low,high] of [[a.x,b.x-a.x,r.x+2,r.x+r.width-2],[a.y,b.y-a.y,r.y+2,r.y+r.height-2]]){
    if(Math.abs(delta)<1e-8){if(start<low||start>high)return false;continue;}
    const ends=[(low-start)/delta,(high-start)/delta].sort((x,y)=>x-y);min=Math.max(min,ends[0]);max=Math.min(max,ends[1]);if(min>max)return false;
  }return true;
}
test('topic relationships reserve clear connector corridors and use the same route as the preview',()=>{
  const nodes=compileMeetingOverview(fixture()),edges=nodes.filter(n=>n.type==='connector');assert.equal(edges.length,4);
  for(const edge of edges){
    const a=endpoint(edge.connector.start,nodes),b=endpoint(edge.connector.end,nodes),ids=[edge.connector.start.attached_object.id,edge.connector.end.attached_object.id];
    for(const shape of nodes.filter(n=>n.type==='composite_shape'&&!ids.includes(n.id))){
      const contains=p=>p.x>=shape.x&&p.x<=shape.x+shape.width&&p.y>=shape.y&&p.y<=shape.y+shape.height;
      if(contains(a)&&contains(b))continue;
      assert.ok(!crosses(a,b,shape),`${edge.id} crosses unrelated ${shape.id}`);
    }
  }
  assert.ok(edges.every(edge=>edge.connector.shape==='straight'));
});
test('absent categories do not create empty risk matrices or action panels',()=>{
  const text=compileMeetingOverview(fixture()).map(n=>n.text?.text||'').join('');
  assert.doesNotMatch(text,/风险矩阵|行动安排|决策与待确认/);assert.match(text,/讨论主题/);
});

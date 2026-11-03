import './MarkdownPreview.css';
import {ExternalLink} from './ExternalLink';
import {memo,useId,useMemo,type ReactNode} from 'react';

function inline(text:string,prefix:string):ReactNode[] {
  const result:ReactNode[]=[];let offset=0;
  const pattern=/\\([\s\S])|\*\*([^*]+)\*\*|`([^`]+)`|\[\^(\d+)\]|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\n]+)\*/g;
  const decode=(value:string)=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  for(const match of text.matchAll(pattern)){
    if(match.index!>offset)result.push(decode(text.slice(offset,match.index)));
    result.push(match[1]?decode(match[1]):match[2]?<strong key={match.index}>{decode(match[2])}</strong>:match[3]?<code key={match.index}>{decode(match[3])}</code>:match[5]?<ExternalLink key={match.index} href={match[6]}>{decode(match[5])}</ExternalLink>:match[7]?<em key={match.index}>{decode(match[7])}</em>:<sup key={match.index}><a href={`#${prefix}-${match[4]}`}>{match[4]}</a></sup>);
    offset=match.index!+match[0].length;
  }
  if(offset<text.length)result.push(decode(text.slice(offset)));return result;
}
const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(value=>value.trim());
export const MarkdownPreview=memo(function MarkdownPreview({text}:{text:string}){
  const prefix=useId();
  const content=useMemo(()=>{
    const lines=text.split(/\r?\n/),blocks:ReactNode[]=[];
    for(let i=0;i<lines.length;i++){
      const line=lines[i];if(!line.trim())continue;
      if(/^```/.test(line)){
        const key=i,code:string[]=[];i++;for(;i<lines.length&&!/^```/.test(lines[i]);i++)code.push(lines[i]);
        blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);continue;
      }
      if(/^\d+[.)] /.test(line)){
        const key=i,items:string[]=[];for(;i<lines.length&&/^\d+[.)] /.test(lines[i]);i++)items.push(lines[i].replace(/^\d+[.)] /,''));i--;
        blocks.push(<ol key={key}>{items.map((item,j)=><li key={j}>{inline(item,prefix)}</li>)}</ol>);continue;
      }
      if(/^ {0,3}([-*_])(?: *\1){2,} *$/.test(line)){blocks.push(<hr key={i}/>);continue;}
    if(line.startsWith('> ')){blocks.push(<blockquote key={i}>{inline(line.slice(2),prefix)}</blockquote>);continue;}
      const heading=line.match(/^(#{1,6}) (.*)$/),footnote=line.match(/^\[\^(\d+)\]: (.*)$/);
      if(heading){const value=inline(heading[2],prefix);blocks.push(heading[1].length===1?<h2 key={i}>{value}</h2>:heading[1].length===2?<h3 key={i}>{value}</h3>:<h4 key={i}>{value}</h4>);}
      else if(footnote)blocks.push(<p className="markdown-footnote" id={`${prefix}-${footnote[1]}`} key={i}><sup>{footnote[1]}</sup> {inline(footnote[2],prefix)}</p>);
      else if(line.startsWith('|')&&/^\|?[\s:|\-]+$/.test(lines[i+1]||'')){
        const header=cells(line),rows:string[][]=[];const key=i;i+=2;
        for(;i<lines.length&&lines[i].startsWith('|');i++)rows.push(cells(lines[i]));i--;
        blocks.push(<div className="markdown-table" key={key}><table><thead><tr>{header.map((cell,j)=><th key={j}>{inline(cell,prefix)}</th>)}</tr></thead><tbody>{rows.map((row,j)=><tr key={j}>{row.map((cell,k)=><td key={k}>{inline(cell,prefix)}</td>)}</tr>)}</tbody></table></div>);
      }else if(line.startsWith('- ')){
        const key=i,items:string[]=[];for(;i<lines.length&&lines[i].startsWith('- ');i++)items.push(lines[i].slice(2));i--;
        blocks.push(<ul key={key}>{items.map((item,j)=><li key={j}>{inline(item,prefix)}</li>)}</ul>);
      }else blocks.push(<p key={i}>{inline(line,prefix)}</p>);
    }return blocks;
  },[text,prefix]);
  return <article className="markdown-preview" aria-label="文档内容预览">{content}</article>;
});
export type BoardNode={id:string;text:{text:string};mind_map_node?:{parent_id:string}};
export function BoardPreview({nodes}:{nodes:BoardNode[]}){
  const children=useMemo(()=>{const map=new Map<string,BoardNode[]>();for(const node of nodes){const parent=node.mind_map_node?.parent_id||'';const group=map.get(parent)||[];group.push(node);map.set(parent,group);}return map;},[nodes]);
  const branch=(parent:string):ReactNode=><ul>{(children.get(parent)||[]).map(node=><li key={node.id}><span>{node.text.text}</span>{children.has(node.id)&&branch(node.id)}</li>)}</ul>;
  return <section className="feishu-board-preview" aria-label="画板内容预览"><h3>纪要画板</h3>{branch('')}</section>;
}

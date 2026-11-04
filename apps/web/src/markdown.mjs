import {Marked} from 'marked';
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Keep document parsing independent from React and sanitize at the browser boundary.
export function renderMarkdown(text,prefix='md'){
  const parser=new Marked({gfm:true,breaks:false});
  parser.use({renderer:{
    html({text}){return escape(text);},
    heading({tokens,depth}){const level=Math.min(6,depth+1);return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;},
    link({href,title,tokens}){const label=this.parser.parseInline(tokens);const web=/^https?:\/\/([^/?#\s]+)(?:[/?#]|$)/i.exec(href);const safe=href.startsWith('#')||Boolean(web&&!web[1].includes('@')&&!/[\u0000-\u0020<>"`]/.test(href));return safe?`<a href="${escape(href)}"${title?` title="${escape(title)}"`:''}>${label}</a>`:label;},
    image({text}){return `<span class="markdown-image-alt">${escape(text)}</span>`;},
    code({text,lang}){return `<div class="markdown-code"><div class="markdown-code-head"><span>${escape((lang||'').split(/\s/)[0])}</span><button type="button" class="markdown-copy" aria-label="复制代码">复制</button></div><pre><code>${escape(text)}</code></pre></div>`;}
  },extensions:[{
    name:'sourceFootnote',level:'inline',start:src=>src.indexOf('[^'),
    tokenizer(src){const match=/^\[\^(\d+)\]/.exec(src);if(match)return {type:'sourceFootnote',raw:match[0],number:match[1]};},
    renderer(token){return `<sup><a href="#${prefix}-${token.number}">${token.number}</a></sup>`;}
  },{
    name:'sourceFootnoteDefinition',level:'block',start:src=>src.indexOf('[^'),
    tokenizer(src){const match=/^\[\^(\d+)\]:\s+([^\n]*)(?:\n|$)/.exec(src);if(match)return {type:'sourceFootnoteDefinition',raw:match[0],number:match[1],text:match[2]};},
    renderer(token){return `<p class="markdown-footnote" id="${prefix}-${token.number}"><sup>${token.number}</sup> ${parser.parseInline(token.text)}</p>`;}
  }]});
  return parser.parse(text);
}

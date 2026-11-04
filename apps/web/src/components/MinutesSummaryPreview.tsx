import {memo,useMemo} from 'react';
import {summaryBlocksHtml,type SummaryBlocks} from '../../../../packages/records/src/minutes-summary.mjs';
import './MinutesSummaryPreview.css';

export const MinutesSummaryPreview=memo(function MinutesSummaryPreview({blocks}:{blocks:SummaryBlocks}) {
  const html=useMemo(()=>summaryBlocksHtml(blocks),[blocks]);
  return <div dangerouslySetInnerHTML={{__html:html}}/>;
});

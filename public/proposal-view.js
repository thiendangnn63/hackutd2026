import {node,title,count} from './ui.js';
import {searchSegments} from './records.js';
const openReports=new Set();
const labels={queued:'Awaiting interpretation',running:'Interpreting message',proposal_ready:'Suggested observations need review',failed:'Interpretation unavailable',stale:'Changed report needs review',command_review:'Enrollment needs confirmation',command_processed:'Opt-out processed'};
function highlighted(tag,className,value,query){const element=node(tag,className);for(const part of searchSegments(value,query))element.append(part.matched?node('mark','search-mark',part.text):document.createTextNode(part.text));return element;}
export function clearProposalMemory(){openReports.clear();}
export function rememberProposalState(root){
  if(root.closest('.app-view')?.hidden)return;
  for(const details of root.querySelectorAll('[data-proposal-report]')){if(!details.getClientRects().length)continue;if(details.open)openReports.add(details.dataset.proposalReport);else openReports.delete(details.dataset.proposalReport);}
}
export function proposalStatus(report){return report.modelReview?labels[report.modelReview.status]||'Incoming report needs review':null;}
export function createProposalView(report,{query=''}={}){
  const review=report.modelReview;if(!review)return null;
  const view=node('section','proposal-review');view.dataset.proposalStatus=review.status;
  view.append(node('p','proposal-state',proposalStatus(report)));
  const copy=review.status==='command_processed'?'The sender’s outreach consent is off. This command is not a welfare observation.':review.status==='command_review'?'Enrollment still needs confirmation. This request neither enrolls the sender nor confirms welfare.':review.status==='failed'||review.status==='stale'?'The raw message remains available for human review. No suggested observations have been applied.':'Raw message saved. Suggestions remain separate from case evidence and decisions.';
  view.append(node('p','workspace-note',copy));
  if(review.status==='proposal_ready'&&review.proposal){
    const observations=Array.isArray(review.proposal.observations)?review.proposal.observations:[];
    const details=node('details','proposal-details'),summary=node('summary','',`Suggested observations (${count(observations.length)})`);
    summary.dataset.recordFocus='proposal:'+report.id;details.dataset.proposalReport=report.id;details.append(summary);details.open=openReports.has(report.id);
    details.append(node('p','workspace-note','Unaccepted suggestions · not verification, dispatch or a completed assistance task.'));
    for(const observation of observations){
      const item=node('article','proposal-observation');item.append(node('strong','',title(observation.type)),highlighted('p','',observation.summary,query),highlighted('blockquote','',observation.sourceSpan,query),node('small','','Source quote · reported, not independently verified'));details.append(item);
    }
    if(!observations.length)details.append(node('p','workspace-note','No supported observations were proposed. Review the original message.'));
    view.append(details);
  }
  return view;
}

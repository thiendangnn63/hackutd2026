import {node,title,count} from './ui.js';
import {searchSegments} from './records.js';
const openReports=new Set();
const labels={queued:'Awaiting interpretation',running:'Interpreting message',proposal_ready:'Suggested observations need review',accepted:'Accepted as reported evidence',dismissed:'Suggestions dismissed',failed:'Interpretation unavailable',stale:'Changed report needs review',command_review:'Enrollment needs confirmation',command_processed:'Opt-out processed'};
function highlighted(tag,className,value,query){const element=node(tag,className);for(const part of searchSegments(value,query))element.append(part.matched?node('mark','search-mark',part.text):document.createTextNode(part.text));return element;}
export function clearProposalMemory(){openReports.clear();}
export function rememberProposalState(root){
  if(root.closest('.app-view')?.hidden)return;
  for(const details of root.querySelectorAll('[data-proposal-report]')){if(!details.getClientRects().length)continue;if(details.open)openReports.add(details.dataset.proposalReport);else openReports.delete(details.dataset.proposalReport);}
}
export function proposalStatus(report){return report.modelReview?labels[report.modelReview.status]||'Incoming report needs review':null;}
export function createProposalView(report,{query='',onReview}={}){
  const review=report.modelReview;if(!review)return null;
  const view=node('section','proposal-review');view.dataset.proposalStatus=review.status;
  view.append(node('p','proposal-state',proposalStatus(report)));
  const copy=review.status==='command_processed'?'The sender’s outreach consent is off. This command is not a welfare observation.':review.status==='command_review'?'Enrollment still needs confirmation. This request neither enrolls the sender nor confirms welfare.':review.status==='accepted'?'A reviewer accepted these observations as reported evidence. Welfare still requires direct confirmation.':review.status==='dismissed'?'The suggestions were dismissed. The original message remains available for review.':review.status==='failed'||review.status==='stale'?'The raw message remains available for human review. No suggested observations have been applied.':'Raw message saved. Suggestions remain separate from case evidence and decisions.';
  view.append(node('p','workspace-note',copy));
  if(review.reviewDecision){const decision=review.reviewDecision;view.append(node('p','workspace-note',`${decision.reviewerName} · ${decision.note}`));}
  if(review.status==='proposal_ready'&&review.proposal){
    const observations=Array.isArray(review.proposal.observations)?review.proposal.observations:[];
    const details=node('details','proposal-details'),summary=node('summary','',`Suggested observations (${count(observations.length)})`);
    summary.dataset.recordFocus='proposal:'+report.id;details.dataset.proposalReport=report.id;details.append(summary);details.open=openReports.has(report.id);
    details.append(node('p','workspace-note','Unaccepted suggestions · not verification, dispatch or a completed assistance task.'));
    const actionable=typeof onReview==='function'&&/^[a-f0-9]{64}$/.test(review.proposalToken||''),choices=[];
    for(const [index,observation]of observations.entries()){
      const item=node('article','proposal-observation'),heading=node('strong','',title(observation.type));
      if(actionable){const label=node('label','evidence-select'),choice=node('input');choice.type='checkbox';choice.checked=true;choice.name=`proposal-choice:${report.id}:${review.proposalToken}:${index}`;choice.value=String(index);label.append(choice,heading);item.append(label);choices.push(choice);}else item.append(heading);
      item.append(highlighted('p','',observation.summary,query),highlighted('blockquote','',observation.sourceSpan,query),node('small','','Source quote · reported, not independently verified'));details.append(item);
    }
    if(!observations.length)details.append(node('p','workspace-note','No supported observations were proposed. Review the original message.'));
    if(actionable){
      const controls=node('fieldset','proposal-decision');controls.append(node('legend','','Review suggestions'));
      const reviewerLabel=node('label','','Demo reviewer'),reviewer=node('input');reviewer.name=`proposal-reviewer:${report.id}:${review.proposalToken}`;reviewer.value='Officer Rivera (demo)';reviewer.maxLength=120;reviewerLabel.append(reviewer);
      const noteLabel=node('label','','Review note'),note=node('textarea');note.name=`proposal-note:${report.id}:${review.proposalToken}`;note.rows=2;note.maxLength=1500;note.placeholder='Explain what you checked against the original message (at least 20 characters).';noteLabel.append(note);
      const error=node('p','review-flag');error.hidden=true;error.setAttribute('role','alert');
      const actions=node('div','form-row'),accept=node('button','button small primary','Accept selected observations'),dismiss=node('button','button small','Dismiss suggestions');
      for(const [button,action]of [[accept,'accept'],[dismiss,'dismiss']]){
        button.type='button';button.dataset.recordFocus=`proposal-${action}:${report.id}`;
        button.addEventListener('click',()=>{
          const indices=choices.filter(choice=>choice.checked).map(choice=>Number(choice.value));
          const problem=!reviewer.value.trim()?'Name the demo reviewer.':note.value.trim().length<20?'Add a review note of at least 20 characters.':action==='accept'&&!indices.length?'Select at least one observation to accept.':null;
          if(problem){error.textContent=problem;error.hidden=false;(reviewer.value.trim()?note:reviewer).focus();return;}
          error.hidden=true;void onReview({action,reviewerName:reviewer.value.trim(),note:note.value.trim(),expectedProposalToken:review.proposalToken,...(action==='accept'?{observationIndices:indices}:{})});
        });
      }
      accept.disabled=!observations.length;actions.append(accept,dismiss);controls.append(reviewerLabel,noteLabel,error,actions,node('p','workspace-note','Accepting records reported observations only. It does not verify welfare or dispatch assistance.'));details.append(controls);
    }
    view.append(details);
  }
  return view;
}

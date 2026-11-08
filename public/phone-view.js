import {button, node} from './ui.js';
import {proposalStatus} from './proposal-view.js';

const replyLabels = {
  prepared: 'Reply approved. Ready to send.',
  sending: 'Send outcome unknown. A previous request may still be in progress.',
  unknown: 'Send outcome unknown.',
  accepted: 'Photon accepted the reply. Delivery is unconfirmed.',
  delivery_unknown: 'Delivery status is unknown.',
  delivered: 'Photon confirmed delivery.',
  failed: 'Photon reported that the reply failed.',
};
const globalActions = new Set(['listen', 'stop', 'poll']);
const rehearsalText = 'I saw Elena at Oak School. They need water for two people and the road is blocked.';
const correctionText = 'Correction: I did not see Elena at Oak School.';
const simulated = status => ['rehearsal','fixture'].includes(status?.mode);
const sourceName = source => source === 'local_demo_rules' ? 'Local demo interpretation' : source === 'nvidia_nemotron' ? 'NVIDIA Nemotron' : 'Interpretation';

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

// Keep the select and surviving options mounted through background updates.
function updateOptions(select, rows) {
  const available = new Map(Array.from(select.options, option => [option.value, option]));
  let position = 0;
  for (const [value, label] of rows) {
    const option = available.get(value) ?? node('option');
    option.value = value;
    setText(option, label);
    if (select.options[position] !== option) select.insertBefore(option, select.options[position] ?? null);
    available.delete(value);
    position++;
  }
  for (const option of available.values()) option.remove();
}

export function createPhoneView(container, {onAction, onOpenReport}) {
  const details = node('details', 'panel phone-panel');
  const summary = node('summary');
  const readiness = node('span', 'workspace-note');
  const heading = node('strong', '', 'Phone & report review');
  summary.append(heading, readiness);
  const panel = node('div', 'phone-panel-body');
  const composer = node('section', 'phone-rehearsal');
  const composerContext = node('p', 'workspace-note', 'C104 · Elena Brooks · fictional neighbor. Messages and replies stay in this local rehearsal.');
  const presetActions = node('div', 'phone-actions');
  const composerLabel = node('label', '', 'Fictional incoming message');
  const composerText = node('textarea');
  composerText.rows = 3; composerText.maxLength = 3000; composerText.name = 'phone-rehearsal-text';
  composerText.dataset.recordFocus = 'phone:composer';
  composerLabel.append(composerText);
  const composerActions = node('div', 'phone-actions');
  const composerHint = node('p', 'workspace-note', 'Edit the example, receive it, then review the quoted suggestions. Replay checks duplicate handling; STOP turns off the fictional sender’s consent.');
  composer.append(node('h3', '', 'Rehearse an incoming report'), composerContext, presetActions, composerLabel, composerActions, composerHint);
  const inbound = node('div', 'phone-actions phone-inbound');
  const selection = node('label', '', 'Captured report');
  const select = node('select');
  selection.append(select);
  const reportActions = node('div', 'phone-actions');
  const modelStatus = node('p', 'workspace-note');
  const reply = node('section', 'phone-reply');
  const replyHeading = node('h3', '', 'Demo reply');
  const wording = node('blockquote');
  const replyStatus = node('p', 'workspace-note');
  const replyActions = node('div', 'phone-actions');
  const feedback = node('p', 'workspace-note');
  feedback.setAttribute('role', 'status');
  const controls = new Map();
  let status = null, state = null, selected = '', pending = false, selectionRequired = false;
  let composerScenario = 'message', composerInitialized = false, rehearsalOpened = false;
  function lastIncomingText() {
    if (typeof status?.rehearsalInputText === 'string' && status.rehearsalInputText.trim()) return status.rehearsalInputText;
    const eligible = new Set(status?.eligibleReportIds ?? []);
    return (state?.reports ?? []).filter(report => eligible.has(report.id)).at(-1)?.text || '';
  }
  for (const [id, caption, text, scenario] of [['example','Sighting example',rehearsalText,'message'],['correction','Correction',correctionText,'correction'],['stop-message','STOP','STOP','stop']]) {
    const preset = button(caption, () => {
      if (pending) return;
      composerText.value = text; composerScenario = scenario; setText(feedback, ''); render(); composerText.focus();
    });
    preset.dataset.recordFocus = 'phone:' + id; presetActions.append(preset);
  }

  function control(parent, id, caption) {
    const element = button(caption, () => {
      if (element.getAttribute('aria-disabled') === 'true') return;
      if (id === 'open') { onOpenReport(selected); return; }
      void perform(id);
    });
    element.dataset.phoneAction = id;
    element.dataset.recordFocus = 'phone:' + id;
    parent.append(element);
    controls.set(id, element);
  }
  function available(id, allowed) {
    const element = controls.get(id);
    // A completed action may change the focused button's availability. Keep
    // the DOM focus in place and enforce its new state in the click handler.
    element.setAttribute('aria-disabled', String(!allowed));
    element.tabIndex = allowed ? 0 : -1;
  }
  async function perform(action) {
    if (pending || controls.get(action)?.getAttribute('aria-disabled') !== 'false') return;
    pending = true;
    setText(feedback, '');
    render();
    try {
      const payload = action === 'simulate' ? {action:'simulate',text:composerText.value,scenario:composerScenario}
        : action === 'duplicate' ? {action:'simulate',text:lastIncomingText(),scenario:'duplicate'}
        : globalActions.has(action) ? {action} : {action, reportId: selected};
      const result = await onAction(payload);
      if (action === 'simulate') {
        const latest = result?.reportIds?.at(-1) || result?.reportId;
        if (typeof latest === 'string' && status?.eligibleReportIds?.includes(latest)) { selected = latest; selectionRequired = false; }
      }
    } catch {
      setText(feedback, 'The action could not be confirmed. Check its status before trying again.');
    } finally {
      pending = false;
      render();
    }
  }
  control(inbound, 'listen', 'Listen');
  control(inbound, 'stop', 'Stop listening');
  control(inbound, 'poll', 'Check phone');
  control(composerActions, 'simulate', 'Receive simulated message');
  control(composerActions, 'duplicate', 'Replay last report');
  control(reportActions, 'open', 'Open report for review');
  control(reportActions, 'interpret', 'Interpret report');
  control(replyActions, 'prepare', 'Approve demo reply');
  control(replyActions, 'send', 'Send approved reply');
  control(replyActions, 'retry', 'Retry approved reply');
  control(replyActions, 'delivery', 'Check delivery');
  reply.append(replyHeading, wording, replyStatus, replyActions);
  panel.append(composer, inbound, selection, reportActions, modelStatus, reply, feedback);
  details.append(summary, panel);
  container.replaceChildren(details);
  select.addEventListener('change', () => { selected = select.value; selectionRequired = !selected; setText(feedback, ''); render(); });
  composerText.addEventListener('input', () => {
    if (composerScenario === 'stop' && composerText.value.trim().toUpperCase() !== 'STOP' || composerScenario === 'correction' && !/^correction\b/i.test(composerText.value.trim())) composerScenario = 'message';
    render();
  });

  function render() {
    const reports = new Map((state?.reports ?? []).map(report => [report.id, report]));
    const cases = new Map((state?.cases ?? []).map(item => [item.id, item]));
    const ids = [...new Set(status?.eligibleReportIds ?? [])].filter(id => reports.has(id));
    const previous = selected;
    if (!ids.includes(selected)) selected = '';
    // Auto-select the first available report only when no prior report was
    // removed. Avoid silently redirecting actions when the exercise resets.
    if (!selected && !previous && ids.length === 1 && !selectionRequired) selected = ids[0];
    if (previous && !selected) selectionRequired = true;
    if (selected) selectionRequired = false;
    const options = [['', ids.length ? 'Choose a report' : 'No captured reports']];
    for (const id of ids) {
      const report = reports.get(id), item = cases.get(report.caseId);
      const subjects = Array.isArray(item?.subjectNames) ? item.subjectNames.join(', ') : item?.subjectNames;
      options.push([id, [id, item?.id, subjects || 'Unassigned'].filter(Boolean).join(' · ')]);
    }
    updateOptions(select, options);
    if (select.value !== selected) select.value = selected;
    const report = reports.get(selected);
    const currentReply = status?.replyStates?.find(entry => entry.reportId === selected);
    const configured = status?.enabled === true;
    const phone = status?.phoneConfigured === true;
    const model = status?.modelConfigured === true;
    const active = configured && (!status.endsAt || Date.now() < Date.parse(status.endsAt));
    const rehearsal = status?.mode === 'rehearsal';
    if (rehearsal && !rehearsalOpened) { details.open = true; rehearsalOpened = true; }
    if (rehearsal && !composerInitialized) { composerText.value = rehearsalText; composerInitialized = true; }
    composer.hidden = !rehearsal;
    inbound.hidden = rehearsal;
    const consentRevoked = status?.lastStopReason === 'consent_revoked';
    const canPoll = active && phone && !consentRevoked && !pending;
    const used = status?.modelUsed, limit = status?.modelLimit;
    const quotaKnown = Number.isInteger(used) && Number.isInteger(limit);
    const modelText = model ? sourceName(status?.extractorSource) + (status?.extractorSource === 'local_demo_rules' ? '' : ' configured') : 'Interpretation off';
    const phoneText = consentRevoked ? 'Stopped · consent revoked' : status?.listening ? (simulated(status) ? 'Simulated listening' : 'Listening') : phone ? (simulated(status) ? 'Simulated phone' : 'Phone configured') : 'Phone unconfigured';
    const mode = rehearsal ? 'Offline rehearsal' : status?.mode === 'fixture' ? 'Local fixture' : status?.mode === 'live-test' ? 'Live phone test' : 'Offline';
    setText(heading, rehearsal ? 'Offline phone rehearsal' : 'Phone & report review');
    setText(readiness, status ? [mode, phoneText, modelText, ...(configured && !active ? ['Test window ended'] : [])].join(' · ') : 'Status unavailable');
    available('listen', canPoll && !status.listening);
    available('stop', status?.listening === true && !pending);
    available('poll', canPoll);
    available('open', Boolean(report) && typeof onOpenReport === 'function');
    const local = status?.extractorSource === 'local_demo_rules';
    const modelCount = local && Number.isInteger(used) ? 'Local interpretations: ' + used + '.' : quotaKnown ? (status?.extractorSource === 'nvidia_nemotron' ? 'Nemotron requests' : 'Interpretations') + ' used: ' + used + ' of ' + limit + '.' : '';
    const localLimit = local && quotaKnown && used >= limit ? 'Local rehearsal limit reached. Reset exercise to start again.' : '';
    setText(modelStatus, [report && proposalStatus(report), modelCount, localLimit].filter(Boolean).join(' · '));
    available('interpret', active && model && !consentRevoked && !pending && report?.modelReview?.status === 'queued' && quotaKnown && used < limit);
    setText(controls.get('interpret'), status?.extractorSource === 'local_demo_rules' ? 'Interpret locally' : status?.extractorSource === 'nvidia_nemotron' ? 'Interpret with Nemotron' : 'Interpret report');
    const canSimulate = rehearsal && active && status?.canSimulate === true && !pending;
    available('simulate', canSimulate && composerText.value.trim().length > 0 && composerText.value.length <= 3000);
    available('duplicate', canSimulate && ids.length > 0 && lastIncomingText().length > 0);
    setText(controls.get('listen'), simulated(status) ? 'Start simulated listening' : 'Listen');
    setText(controls.get('poll'), simulated(status) ? 'Check simulated inbox' : 'Check phone');
    setText(replyHeading, simulated(status) ? 'Simulated reply' : 'Demo reply');
    setText(controls.get('prepare'), simulated(status) ? 'Approve simulated reply' : 'Approve demo reply');
    setText(controls.get('send'), simulated(status) ? 'Simulate sending reply' : 'Send approved reply');
    setText(controls.get('retry'), simulated(status) ? 'Retry simulated reply' : 'Retry approved reply');
    setText(controls.get('delivery'), simulated(status) ? 'Check simulated delivery' : 'Check delivery');
    const canSend = canPoll && status.sendingEnabled === true && Boolean(report);
    const hasText = typeof status?.replyText === 'string' && status.replyText.trim().length > 0;
    setText(wording, hasText ? status.replyText : 'No reply text configured.');
    const replyLabel = currentReply ? replyLabels[currentReply.status] || 'Reply status unknown.'
      : status?.sendingEnabled ? 'Approval required before sending.' : 'Sending disabled.';
    setText(replyStatus, currentReply && simulated(status)
      ? 'Simulated result · ' + replyLabel.replace('Photon ', 'The rehearsal ') : simulated(status) && !currentReply ? 'No external message is sent. ' + replyLabel : replyLabel);
    available('prepare', canSend && hasText && !currentReply);
    available('send', canSend && hasText && currentReply?.status === 'prepared');
    available('retry', canSend && hasText && ['unknown', 'sending'].includes(currentReply?.status) && currentReply.attempts < 2);
    available('delivery', canPoll && Boolean(report) && ['accepted','delivery_unknown'].includes(currentReply?.status));
  }
  function update(nextStatus, nextState) {
    status = nextStatus;
    state = nextState;
    render();
  }
  function resetDraft() {
    selected = ''; selectionRequired = false; composerScenario = 'message';
    composerText.value = rehearsalText; composerInitialized = true;
    setText(feedback, '');
  }
  update(null, null);
  return Object.freeze({update, resetDraft});
}

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
  summary.append(node('strong', '', 'Phone & Nemotron'), readiness);
  const panel = node('div', 'phone-panel-body');
  const inbound = node('div', 'phone-actions');
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
      await onAction(globalActions.has(action) ? {action} : {action, reportId: selected});
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
  control(reportActions, 'open', 'Open report for review');
  control(reportActions, 'interpret', 'Interpret with Nemotron');
  control(replyActions, 'prepare', 'Approve demo reply');
  control(replyActions, 'send', 'Send approved reply');
  control(replyActions, 'retry', 'Retry approved reply');
  control(replyActions, 'delivery', 'Check delivery');
  reply.append(replyHeading, wording, replyStatus, replyActions);
  panel.append(inbound, selection, reportActions, modelStatus, reply, feedback);
  details.append(summary, panel);
  container.replaceChildren(details);
  select.addEventListener('change', () => { selected = select.value; selectionRequired = !selected; setText(feedback, ''); render(); });

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
    const consentRevoked = status?.lastStopReason === 'consent_revoked';
    const canPoll = active && phone && !consentRevoked && !pending;
    const used = status?.modelUsed, limit = status?.modelLimit;
    const quotaKnown = Number.isInteger(used) && Number.isInteger(limit);
    const modelText = model ? 'Nemotron configured' : 'Nemotron unconfigured';
    const phoneText = consentRevoked ? 'Stopped · consent revoked' : status?.listening ? 'Listening' : phone ? 'Phone configured' : 'Phone unconfigured';
    const mode = status?.mode === 'fixture' ? 'Local fixture' : status?.mode === 'live-test' ? 'Live test' : 'Offline';
    setText(readiness, status ? [mode, phoneText, modelText, ...(configured && !active ? ['Test window ended'] : [])].join(' · ') : 'Status unavailable');
    available('listen', canPoll && !status.listening);
    available('stop', status?.listening === true && !pending);
    available('poll', canPoll);
    available('open', Boolean(report) && typeof onOpenReport === 'function');
    const modelCount = quotaKnown ? 'Nemotron requests used: ' + used + ' of ' + limit + '.' : '';
    setText(modelStatus, [report && proposalStatus(report), modelCount].filter(Boolean).join(' · '));
    available('interpret', active && model && !pending && report?.modelReview?.status === 'queued' && quotaKnown && used < limit);
    const canSend = canPoll && status.sendingEnabled === true && Boolean(report);
    const hasText = typeof status?.replyText === 'string' && status.replyText.trim().length > 0;
    setText(wording, hasText ? status.replyText : 'No reply text configured.');
    const replyLabel = currentReply ? replyLabels[currentReply.status] || 'Reply status unknown.'
      : status?.sendingEnabled ? 'Approval required before sending.' : 'Sending disabled.';
    setText(replyStatus, currentReply && status?.mode === 'fixture'
      ? 'Fixture result · ' + replyLabel.replace('Photon ', 'Mock provider ') : replyLabel);
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
  update(null, null);
  return Object.freeze({update});
}

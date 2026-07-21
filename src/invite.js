/**
 * WholeTeam — invite email builder. Pure function, no I/O, unit-testable.
 * The main process feeds the result to nodemailer.
 */

'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * @param {object} p
 * @param {string} p.name        invitee's name
 * @param {string} p.company     company name ('' falls back to 'the team')
 * @param {string} p.department  assigned department ('' allowed)
 * @param {string} p.inviterName who sent the invite ('' allowed)
 * @param {string} p.joinAddr    chat join address like '192.168.1.24:4600' ('' if not hosting)
 * @param {string} p.appUrl      where to download WholeTeam
 * @returns {{subject: string, text: string, html: string}}
 */
function buildInvite({ name = '', company = '', department = '', inviterName = '', joinAddr = '', appUrl = 'https://github.com/bensblueprints/orgtree-mvp' } = {}) {
  const org = company || 'the team';
  const subject = `You've been added to ${org}'s org chart` + (department ? ` — ${department}` : '');

  const steps = [
    `1. Install WholeTeam on your computer: ${appUrl}`,
    joinAddr
      ? `2. Open the chat icon (top right) and join the office chat at: ${joinAddr}`
      : `2. Open the chat icon (top right) and join your office chat (ask ${inviterName || 'your admin'} for the address).`,
    `3. Claim your name from the list, then open "My profile" and fill in your details — phone, location, start date. Your info appears on the company chart automatically.`,
  ];

  const text = [
    `Hi ${name || 'there'},`,
    '',
    `${inviterName ? inviterName + ' has' : "You've been"} added you to ${org}'s org chart${department ? ` in the ${department} department` : ''}.`,
    '',
    'Getting set up takes two minutes:',
    ...steps,
    '',
    `WholeTeam runs entirely inside ${org}'s own network — your messages and details never touch the cloud.`,
  ].join('\n');

  const html = `
  <div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:520px;margin:0 auto;color:#101828">
    <div style="padding:24px 0 12px"><span style="font-size:20px;font-weight:700;color:#0b66ff">WholeTeam</span></div>
    <h2 style="font-size:19px;margin:0 0 12px">Welcome to ${esc(org)}${department ? ` — ${esc(department)}` : ''}</h2>
    <p style="font-size:14px;line-height:1.6">Hi ${esc(name || 'there')},<br>
    ${inviterName ? esc(inviterName) + ' has' : 'You&#39;ve been'} added you to ${esc(org)}&#39;s org chart${department ? ` in the <b>${esc(department)}</b> department` : ''}. Getting set up takes two minutes:</p>
    <ol style="font-size:14px;line-height:1.8;padding-left:20px">
      <li><a href="${esc(appUrl)}" style="color:#0b66ff">Install WholeTeam</a> on your computer.</li>
      <li>Click the chat icon (top right) and join the office chat${joinAddr ? ` at <b style="user-select:all">${esc(joinAddr)}</b>` : ` (ask ${esc(inviterName || 'your admin')} for the address)`}.</li>
      <li>Claim your name from the list, then open <b>My profile</b> and fill in your details — they appear on the company chart automatically.</li>
    </ol>
    <p style="font-size:12.5px;color:#667085;line-height:1.6">WholeTeam runs entirely inside ${esc(org)}&#39;s own network — your messages and details never touch the cloud.</p>
  </div>`;

  return { subject, text, html };
}

const WholeTeamInvite = { buildInvite };
if (typeof module !== 'undefined' && module.exports) module.exports = WholeTeamInvite;
if (typeof window !== 'undefined') window.WholeTeamInvite = WholeTeamInvite;

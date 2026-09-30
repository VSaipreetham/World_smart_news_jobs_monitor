'use strict';

const { randomUUID } = require('node:crypto');

function validRecipient(value) {
  return typeof value === 'string' && value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(value);
}

function encodedHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value).replace(/[\r\n]/g, ' ')).toString('base64')}?=`;
}

function toMime(draft, profile, resume) {
  if (!validRecipient(draft.recipient) || !validRecipient(profile.email)) throw new Error('A valid sender and one recipient are required.');
  if (!resume?.base64) throw new Error('Upload your resume before preparing an application email.');
  const boundary = `careerops_${randomUUID().replace(/-/g, '')}`;
  const filename = String(resume.name || 'resume.pdf').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,100);
  const line = value => String(value).match(/.{1,76}/g)?.join('\r\n') || '';
  return [
    `From: ${profile.email}`, `To: ${draft.recipient}`, `Subject: ${encodedHeader(draft.subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${draft.id}.${draft.digest.slice(0,16)}@careerops.local>`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    line(Buffer.from(draft.body).toString('base64')), '',
    `--${boundary}`, `Content-Type: ${['application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(resume.type) ? resume.type : 'application/octet-stream'}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`, 'Content-Transfer-Encoding: base64', '',
    line(resume.base64), '', `--${boundary}--`, '',
  ].join('\r\n');
}

class GmailMailer {
  constructor({ env = process.env, fetchImpl = fetch } = {}) { this.env = env; this.fetch = fetchImpl; }
  get configured() { return Boolean(this.env.GMAIL_ACCESS_TOKEN); }
  async preflight(profile) {
    if (!this.configured) throw new Error('Email delivery is not configured. Download the approved draft instead.');
    const response = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      redirect: 'error', headers: { Authorization: `Bearer ${this.env.GMAIL_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Gmail authorization needs attention.');
    const data = await response.json();
    if (String(data.emailAddress).toLowerCase() !== String(profile.email).toLowerCase()) throw new Error('The connected Gmail account does not match the application profile.');
  }
  async send(draft, profile, resume) {
    const raw = Buffer.from(toMime(draft, profile, resume)).toString('base64url');
    // One network attempt only. A timeout can occur after Gmail accepted the message.
    const response = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.env.GMAIL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Email delivery was not confirmed. Check Gmail before trying again.');
    const data = await response.json();
    if (!data.id) throw new Error('Email delivery was not confirmed. Check Gmail before trying again.');
    return { provider: 'gmail', id: data.id, threadId: data.threadId || null };
  }
}

module.exports = { GmailMailer, validRecipient, toMime };

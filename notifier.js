/**
 * Notification module — Telegram + Email alerts for new jobs.
 */

const nodemailer = require('nodemailer');

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(job) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Notifier] Telegram credentials not set — skipping.');
    return;
  }

  const emojiMap = { naukri: '🟠', linkedin: '🔵' };
  const emoji = emojiMap[job.source?.toLowerCase()] || '💼';

  const message =
    `🆕 <b>New Job Alert!</b> ${emoji}\n\n` +
    `💼 <b>${job.title}</b>\n` +
    `🏢 ${job.company}\n` +
    `📍 ${job.location}\n` +
    `🔗 <a href="${job.url}">View Job</a>\n\n` +
    `<i>Powered by Job Monitor</i>`;

  let messages = [message];
  if (job.isWalkin) {
    messages.push(
      `🚨🚨 <b>WALK-IN OPPORTUNITY DETECTED!</b> 🚨🚨\n\n` +
      `💼 <b>${job.title}</b>\n` +
      `🏢 ${job.company}\n` +
      `📍 ${job.location}\n` +
      `🔗 <a href="${job.url}">View Job</a>\n\n` +
      `<i>Don't miss this walk-in drive!</i>`
    );
  }

  for (const msg of messages) {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
        }),
      });

      if (res.ok) {
        console.log(`[Notifier] Telegram sent → ${job.title} @ ${job.company}`);
      } else {
        const text = await res.text();
        console.log(`[Notifier] Telegram failed (${res.status}): ${text}`);
      }
    } catch (err) {
      console.log(`[Notifier] Telegram error: ${err.message}`);
    }
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendEmail(job) {
  const enabled = (process.env.EMAIL_ENABLED || 'true').toLowerCase() === 'true';
  if (!enabled) return;

  const sender = process.env.EMAIL_SENDER;
  const password = process.env.EMAIL_PASSWORD;
  const recipient = process.env.EMAIL_RECIPIENT;
  const smtpServer = process.env.SMTP_SERVER || 'smtp.gmail.com';

  if (!sender || !password || !recipient) {
    console.log('[Notifier] Email credentials not set — skipping.');
    return;
  }

  const emojiMap = { naukri: '🟠', linkedin: '🔵' };
  const emoji = emojiMap[job.source?.toLowerCase()] || '💼';

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
      <h2>🆕 New Job Alert! ${emoji}</h2>
      <p><strong>Position:</strong> ${job.title}</p>
      <p><strong>Company:</strong> ${job.company}</p>
      <p><strong>Location:</strong> ${job.location}</p>
      <p><strong>Source:</strong> ${job.source}</p>
      <p><a href="${job.url}" style="background-color: #0A7EC0; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">View Job</a></p>
      <hr>
      <p><em>Powered by Job Monitor</em></p>
    </div>
  `;

  const ports = [587, 465];
  for (const port of ports) {
    try {
      console.log(`[Notifier] Trying SMTP ${smtpServer}:${port}...`);
      const transporter = nodemailer.createTransport({
        host: smtpServer,
        port,
        secure: port === 465,
        auth: { user: sender, pass: password },
        connectionTimeout: 10000,
      });

      await transporter.sendMail({
        from: sender,
        to: recipient,
        subject: `🆕 New Job: ${job.title} @ ${job.company}`,
        html,
      });

      console.log(`[Notifier] Email sent via ${smtpServer}:${port} → ${job.title} @ ${job.company}`);
      return;
    } catch (err) {
      console.log(`[Notifier] SMTP ${smtpServer}:${port} failed: ${err.message}`);
    }
  }
  console.log('[Notifier] All SMTP attempts exhausted.');
}

// ── Combined ──────────────────────────────────────────────────────────────────

async function notify(job) {
  await Promise.allSettled([sendTelegram(job), sendEmail(job)]);
}

module.exports = { notify };

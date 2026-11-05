const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('./logger');

/**
 * Outgoing email. Three transports (MAIL_TRANSPORT):
 *  - console: prints the whole email, including the token, to stdout. The brief allows this.
 *             It deliberately bypasses the structured logger so tokens never enter log lines.
 *  - smtp:    real delivery (Mailtrap etc.)
 *  - memory:  collected in `outbox` so tests can read tokens
 */
const outbox = [];
let smtpTransporter;

async function sendMail({ to, subject, text }) {
  const message = { from: config.mail.from, to, subject, text };

  switch (config.mail.transport) {
    case 'memory':
      outbox.push({ ...message, sentAt: new Date() });
      break;
    case 'smtp':
      if (!smtpTransporter) {
        const { host, port, user, pass } = config.mail.smtp;
        smtpTransporter = nodemailer.createTransport({
          host,
          port,
          secure: port === 465,
          auth: user ? { user, pass } : undefined,
        });
      }
      await smtpTransporter.sendMail(message);
      break;
    default:
      process.stdout.write(
        `\n========== EMAIL (console transport) ==========\nTo: ${to}\nSubject: ${subject}\n\n${text}\n===============================================\n`,
      );
  }
  logger.info({ to, subject, transport: config.mail.transport }, 'Email sent');
}

function verificationEmail(rawToken, ttlHours) {
  return {
    subject: 'Verify your KoboMarket email',
    text:
      `Welcome to KoboMarket!\n\nVerify your email within ${ttlHours} hours by sending a POST request to\n` +
      `${config.appBaseUrl}/api/v1/auth/verify-email with the JSON body {"token": "<token>"}.\n\n` +
      `Token: ${rawToken}\n`,
  };
}

function passwordResetEmail(rawToken, ttlMinutes) {
  return {
    subject: 'Reset your KoboMarket password',
    text:
      `We received a request to reset your password. It expires in ${ttlMinutes} minutes.\n\n` +
      `Send a POST request to ${config.appBaseUrl}/api/v1/auth/reset-password with the JSON body\n` +
      `{"token": "<token>", "newPassword": "<new password>"}.\n\n` +
      `Token: ${rawToken}\n\nIf you did not ask for this, ignore this email.\n`,
  };
}

module.exports = { sendMail, verificationEmail, passwordResetEmail, outbox };

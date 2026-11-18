const ejs = require('ejs');
const path = require('path');
const config = require('../../config');
const { sendMail: deliverMail } = require('../../utils/mailer');

const templatesDir = __dirname;

const sendEmail = async ({ to, subject, template, data, text }) => {
  const html = await ejs.renderFile(path.join(templatesDir, `${template}.ejs`), data);
  await deliverMail({ to, subject, html, text });
};

async function sendVerificationEmail({ to, name, rawToken, ttlHours }) {
  const frontendUrl = config.frontendBaseUrl.replace(/\/+$/, '');
  const verificationUrl = `${frontendUrl}/verify-email#token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to,
    subject: 'Verify your KoboMarket email',
    template: 'verify-email',
    data: { firstName: name, verificationUrl, ttlHours },
    text:
      `Welcome to KoboMarket!\n\nClick this link to verify your email within ${ttlHours} hours:\n` +
      `${verificationUrl}\n\nIf the link does not work, visit ${frontendUrl}/verify-email and enter this token:\n` +
      `Token: ${rawToken}\n`,
  });
}

module.exports = { sendEmail, sendVerificationEmail };
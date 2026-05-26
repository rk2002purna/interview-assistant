/**
 * Resend-based email delivery for verification and password reset emails.
 *
 * Resend's free tier includes 100 emails/day — enough for development and
 * low-volume production use. Upgrade to a paid plan when volume grows.
 *
 * The factory returns two sender functions matching the interfaces expected
 * by register-routes.ts and password-reset-routes.ts, so they slot into the
 * existing dependency-injection seam without changes to those modules.
 */

import type { VerificationEmailSender } from './register-routes.js';
import type { PasswordResetEmailSender } from './password-reset-routes.js';

export interface ResendEmailSenderDeps {
  /** Resend API key (starts with "re_"). */
  readonly apiKey: string;
  /** Verified "from" address or domain in Resend. */
  readonly from: string;
  /**
   * Base URL of the web app, used to build verification links.
   * Defaults to http://localhost:5173 (Vite dev server).
   */
  readonly webAppBaseUrl?: string;
}

/**
 * Build both email sender functions backed by the Resend API.
 *
 * The caller (server.ts) passes the returned functions as DI dependencies
 * to buildAuthRegisterRouter and buildPasswordResetRouter.
 */
export function buildResendEmailSenders(deps: ResendEmailSenderDeps): {
  sendVerificationEmail: VerificationEmailSender;
  sendPasswordResetEmail: PasswordResetEmailSender;
} {
  const webAppBaseUrl = deps.webAppBaseUrl ?? 'http://localhost:5173';

  const sendVerificationEmail: VerificationEmailSender = async ({ email, token, userId }) => {
    const verifyUrl = `${webAppBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;

    // Dynamic import so tests that don't need Resend never load it.
    const { Resend } = await import('resend');
    const resend = new Resend(deps.apiKey);

    await resend.emails.send({
      from: deps.from,
      to: [email],
      subject: 'Verify your email — UpNod',
      html: verificationHtml(verifyUrl),
    });
  };

  const sendPasswordResetEmail: PasswordResetEmailSender = async ({ email, token, userId }) => {
    const resetUrl = `${webAppBaseUrl}/password-reset/confirm?token=${encodeURIComponent(token)}`;

    const { Resend } = await import('resend');
    const resend = new Resend(deps.apiKey);

    await resend.emails.send({
      from: deps.from,
      to: [email],
      subject: 'Reset your password — UpNod',
      html: passwordResetHtml(resetUrl),
    });
  };

  return { sendVerificationEmail, sendPasswordResetEmail };
}

function verificationHtml(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e17;color:#e2e8f0;padding:40px 20px;text-align:center">
  <div style="max-width:420px;margin:0 auto;background:rgba(255,255,255,0.04);border:1px solid rgba(99,179,237,0.15);border-radius:14px;padding:32px 24px">
    <h2 style="color:#63b3ed;margin:0 0 8px">Verify Your Email</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px">Click the button below to verify your email address and activate your UpNod account.</p>
    <a href="${verifyUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;box-shadow:0 2px 16px rgba(59,130,246,0.3)">Verify Email</a>
    <p style="color:#64748b;font-size:12px;margin:20px 0 0">This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>
    <p style="color:#475569;font-size:11px;margin:16px 0 0">If the button doesn't work, copy and paste this link:<br><a href="${verifyUrl}" style="color:#60a5fa;word-break:break-all">${verifyUrl}</a></p>
  </div>
</body>
</html>`;
}

function passwordResetHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e17;color:#e2e8f0;padding:40px 20px;text-align:center">
  <div style="max-width:420px;margin:0 auto;background:rgba(255,255,255,0.04);border:1px solid rgba(99,179,237,0.15);border-radius:14px;padding:32px 24px">
    <h2 style="color:#63b3ed;margin:0 0 8px">Reset Your Password</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px">Click the button below to set a new password for your UpNod account.</p>
    <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;box-shadow:0 2px 16px rgba(59,130,246,0.3)">Reset Password</a>
    <p style="color:#64748b;font-size:12px;margin:20px 0 0">This link expires in 60 minutes. If you didn't request a password reset, you can ignore this email.</p>
    <p style="color:#475569;font-size:11px;margin:16px 0 0">If the button doesn't work, copy and paste this link:<br><a href="${resetUrl}" style="color:#60a5fa;word-break:break-all">${resetUrl}</a></p>
  </div>
</body>
</html>`;
}

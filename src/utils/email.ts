// ABOUTME: Email sending utility using SendGrid API for username reservation confirmations
// ABOUTME: Cloudflare Worker compatible - uses fetch() instead of Node HTTP modules

interface SendGridPayload {
  personalizations: Array<{ to: Array<{ email: string }> }>
  from: { email: string; name: string }
  subject: string
  content: Array<{ type: string; value: string }>
  tracking_settings: {
    click_tracking: { enable: boolean }
    open_tracking: { enable: boolean }
  }
}

async function sendViaSendGrid(apiKey: string, payload: SendGridPayload): Promise<void> {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`SendGrid error ${response.status}: ${body}`)
  }
}

export async function sendAssignmentNotificationEmail(
  apiKey: string,
  toEmail: string,
  name: string
): Promise<void> {
  const subject = `Your diVine username @${name} has been assigned`

  const htmlContent = `<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #00B488;">Your diVine username is ready</h1>
  <p>Your username <strong>@${name}</strong> has been assigned to your account on diVine.</p>
  <p>Your profile is now live at:</p>
  <div style="margin: 20px 0;">
    <a href="https://${name}.divine.video/"
       style="color: #00B488; font-size: 18px; font-weight: bold; text-decoration: none;">
      ${name}.divine.video
    </a>
  </div>
  <p>You can now use <strong>${name}@divine.video</strong> as your NIP-05 identifier on Nostr.</p>
  <p style="color: #666; font-size: 14px; margin-top: 30px;">
    If you have any questions, please reach out to the diVine team.
  </p>
</body>
</html>`

  const textContent = `Your diVine username @${name} has been assigned

Your username @${name} has been assigned to your account on diVine.

Your profile is now live at: https://${name}.divine.video/

You can now use ${name}@divine.video as your NIP-05 identifier on Nostr.

If you have any questions, please reach out to the diVine team.`

  await sendViaSendGrid(apiKey, {
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: 'noreply@divine.video', name: 'diVine' },
    subject,
    content: [
      { type: 'text/plain', value: textContent },
      { type: 'text/html', value: htmlContent }
    ],
    tracking_settings: {
      click_tracking: { enable: false },
      open_tracking: { enable: false }
    }
  })
}

export async function sendReservationConfirmationEmail(
  apiKey: string,
  toEmail: string,
  name: string,
  confirmationUrl: string
): Promise<void> {
  const subject = `Confirm your diVine username: ${name}`

  const htmlContent = `<html>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #00B488;">Reserve your diVine username</h1>
  <p>You requested to reserve the username <strong>${name}</strong> on diVine.</p>
  <p>Click the button below to confirm your reservation:</p>
  <div style="margin: 30px 0;">
    <a href="${confirmationUrl}"
       style="background: #00B488; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">
      Confirm Username Reservation
    </a>
  </div>
  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${confirmationUrl}" style="color: #00B488;">${confirmationUrl}</a>
  </p>
  <p style="color: #666; font-size: 14px; margin-top: 30px;">
    This link expires in 48 hours. If you didn't request this reservation, you can safely ignore this email.
  </p>
  <p style="color: #666; font-size: 14px;">
    Your username will be reserved for 1 year from confirmation.
  </p>
</body>
</html>`

  const textContent = `Reserve your diVine username: ${name}

You requested to reserve the username "${name}" on diVine.

Confirm your reservation by clicking this link:
${confirmationUrl}

This link expires in 48 hours. If you didn't request this reservation, you can safely ignore this email.

Your username will be reserved for 1 year from confirmation.`

  await sendViaSendGrid(apiKey, {
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: 'noreply@divine.video', name: 'diVine' },
    subject,
    content: [
      { type: 'text/plain', value: textContent },
      { type: 'text/html', value: htmlContent }
    ],
    // Disable tracking to prevent confirmation tokens from passing through SendGrid redirects
    tracking_settings: {
      click_tracking: { enable: false },
      open_tracking: { enable: false }
    }
  })
}

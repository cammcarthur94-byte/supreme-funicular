export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProviderResult {
  id?: string;
  success: boolean;
  error?: string;
}

export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<EmailProviderResult>;
}

/**
 * In-memory / console provider used for automated testing and local dev.
 */
export class MockEmailProvider implements EmailProvider {
  public sentEmails: EmailMessage[] = [];

  async sendEmail(message: EmailMessage): Promise<EmailProviderResult> {
    this.sentEmails.push(message);
    return { id: `mock-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`, success: true };
  }
}

/**
 * Resend Email Provider (https://resend.com)
 */
export class ResendEmailProvider implements EmailProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async sendEmail(message: EmailMessage): Promise<EmailProviderResult> {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          reply_to: message.replyTo,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Resend error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as { id?: string };
      return { id: data.id, success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Postmark Email Provider (https://postmarkapp.com)
 */
export class PostmarkEmailProvider implements EmailProvider {
  private serverToken: string;

  constructor(serverToken: string) {
    this.serverToken = serverToken;
  }

  async sendEmail(message: EmailMessage): Promise<EmailProviderResult> {
    try {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "X-Postmark-Server-Token": this.serverToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to,
          ReplyTo: message.replyTo,
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Postmark error (${response.status}): ${errorText}` };
      }

      const data = (await response.json()) as { MessageID?: string };
      return { id: data.MessageID, success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

let activeEmailProvider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (activeEmailProvider) return activeEmailProvider;

  if (process.env.RESEND_API_KEY) {
    activeEmailProvider = new ResendEmailProvider(process.env.RESEND_API_KEY);
  } else if (process.env.POSTMARK_SERVER_TOKEN) {
    activeEmailProvider = new PostmarkEmailProvider(process.env.POSTMARK_SERVER_TOKEN);
  } else {
    activeEmailProvider = new MockEmailProvider();
  }
  return activeEmailProvider;
}

export function setEmailProviderForTesting(provider: EmailProvider | null): void {
  activeEmailProvider = provider;
}

export interface WinnerEmailTemplateProps {
  storeName: string;
  productTitle: string;
  claimUrl: string;
  deadline: Date;
  timeZone?: string;
}

/**
 * Renders per-merchant branded HTML and plain-text winner notification templates.
 */
export function renderWinnerEmail(props: WinnerEmailTemplateProps): { html: string; text: string } {
  const timeZone = props.timeZone || "UTC";
  const formattedDeadline = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone,
  }).format(props.deadline);

  const text = `Congratulations! You won the raffle on ${props.storeName}!

You have been selected to purchase: ${props.productTitle}.

Your purchase window expires on:
${formattedDeadline} (${timeZone})

To claim your item and complete checkout, use this secure, single-use link:
${props.claimUrl}

Important:
- You must be logged into your customer account on ${props.storeName} to complete checkout.
- If not claimed by the deadline, your reservation will expire and the allocation will be offered to the waitlist.

Best regards,
${props.storeName}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>You Won! ${props.storeName} Raffle</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f6f6f7; margin: 0; padding: 40px 20px;">
  <table align="center" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; border: 1px solid #e1e3e5; padding: 32px;">
    <tr>
      <td>
        <h1 style="color: #202223; font-size: 24px; margin-top: 0;">🎉 You Won the Raffle!</h1>
        <p style="color: #6d7175; font-size: 16px; line-height: 1.5;">
          Congratulations! You have been selected in the raffle hosted by <strong>${props.storeName}</strong>.
        </p>
        <div style="background-color: #f1f2f3; border-radius: 6px; padding: 20px; margin: 24px 0;">
          <p style="margin: 0 0 8px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: #6d7175;">Item Won</p>
          <p style="margin: 0; font-size: 18px; font-weight: 600; color: #202223;">${props.productTitle}</p>
        </div>
        <p style="color: #202223; font-size: 15px; line-height: 1.5;">
          <strong>Claim Deadline:</strong><br>
          <span style="color: #d72c0d; font-weight: 600;">${formattedDeadline}</span> (${timeZone})
        </p>
        <p style="color: #6d7175; font-size: 14px;">
          If you do not complete your purchase before this deadline, your reservation will automatically be cancelled and awarded to the next person on the waitlist.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${props.claimUrl}" style="background-color: #008060; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; display: inline-block;">
            Claim & Complete Purchase
          </a>
        </div>
        <p style="color: #8c9196; font-size: 12px; margin-top: 32px; border-top: 1px solid #e1e3e5; padding-top: 16px;">
          Note: This is a single-use secure link tied to your customer account. You will be prompted to log into ${props.storeName} before proceeding to checkout.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text };
}

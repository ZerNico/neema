import { plainTextSelectors, render } from "@react-email/render";
import { Link, Text } from "react-email";
import type { ReactNode } from "react";
import { Layout } from "./layout.tsx";
import { APP_NAME, footerLink, muted, paragraph } from "./styles.ts";

/** One email in both forms: clients that show no HTML read the text. */
export interface MailContent {
  html?: string;
  text: string;
}

// The text part already prints each button's link beside it, and keeps answer tables as tables.
const TEXT_SELECTORS = [
  ...plainTextSelectors,
  { selector: '[data-text="skip"]', format: "skip" },
  { selector: "table.data", format: "dataTable" },
];

const both = async (email: ReactNode): Promise<MailContent> => ({
  html: await render(email),
  text: await render(email, {
    plainText: true,
    htmlToTextOptions: { selectors: TEXT_SELECTORS },
  }),
});

export const verifyEmailMail = (url: string) =>
  both(
    <Layout
      preview="Confirm this address to finish signing up."
      heading="Confirm your email"
      action={{ label: "Confirm email", href: url }}
      footer={
        <Text style={muted}>If you didn’t create an account, you can ignore this email.</Text>
      }
    >
      <Text style={paragraph}>Confirm this address to finish setting up your account.</Text>
    </Layout>,
  );

export const resetPasswordMail = (url: string) =>
  both(
    <Layout
      preview="Reset the password for this address."
      heading="Reset your password"
      action={{ label: "Reset password", href: url }}
      footer={
        <Text style={muted}>
          If this wasn’t you, ignore this email. Your password stays the same.
        </Text>
      }
    >
      <Text style={paragraph}>
        Someone asked to reset the password for this address. The link works for one hour.
      </Text>
    </Layout>,
  );

export const testMail = () =>
  both(
    <Layout
      preview="Email from neema works."
      heading="Email works"
      footer={<Text style={muted}>Sent from the email settings in {APP_NAME}.</Text>}
    >
      <Text style={paragraph}>
        This is a test from {APP_NAME}. Schedules can now notify people by email.
      </Text>
    </Layout>,
  );

/**
 * A notification. `answer` is email HTML the caller made safe; without it the
 * notification's own one-line body is the message.
 */
export const notificationMail = (input: {
  title: string;
  body: string;
  answer?: { html: string; truncated: boolean } | undefined;
  openUrl?: string | undefined;
  manageUrl?: string | undefined;
  settingsUrl?: string | undefined;
}) =>
  both(
    <Layout
      preview={input.body}
      heading={input.title}
      action={input.openUrl ? { label: "Open chat", href: input.openUrl } : undefined}
      footer={
        <Text style={muted}>
          You get this because email notifications are on.
          {input.manageUrl ? (
            <>
              {" "}
              <Link href={input.manageUrl} style={footerLink}>
                Edit schedule
              </Link>
            </>
          ) : null}
          {input.settingsUrl ? (
            <>
              {" · "}
              <Link href={input.settingsUrl} style={footerLink}>
                Notification settings
              </Link>
            </>
          ) : null}
        </Text>
      }
    >
      {input.answer ? (
        <>
          <div dangerouslySetInnerHTML={{ __html: input.answer.html }} />
          {input.answer.truncated ? (
            <Text style={{ ...paragraph, color: "#71717a" }}>
              {input.openUrl ? "Continue reading in the chat." : "The rest is in the chat."}
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={paragraph}>{input.body}</Text>
      )}
    </Layout>,
  );

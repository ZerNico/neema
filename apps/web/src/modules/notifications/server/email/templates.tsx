import { plainTextSelectors, render } from "@react-email/render";
import { Link, Text } from "react-email";
import type { ReactNode } from "react";
import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
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

export const verifyEmailMail = (url: string, locale: Locale) =>
  both(
    <Layout
      locale={locale}
      preview={m.notifications_mail_verify_preview({}, { locale })}
      heading={m.notifications_mail_verify_heading({}, { locale })}
      action={{ label: m.notifications_mail_verify_action({}, { locale }), href: url }}
      footer={<Text style={muted}>{m.notifications_mail_verify_footer({}, { locale })}</Text>}
    >
      <Text style={paragraph}>{m.notifications_mail_verify_body({}, { locale })}</Text>
    </Layout>,
  );

export const resetPasswordMail = (url: string, locale: Locale) =>
  both(
    <Layout
      locale={locale}
      preview={m.notifications_mail_reset_preview({}, { locale })}
      heading={m.notifications_mail_reset_heading({}, { locale })}
      action={{ label: m.notifications_mail_reset_action({}, { locale }), href: url }}
      footer={<Text style={muted}>{m.notifications_mail_reset_footer({}, { locale })}</Text>}
    >
      <Text style={paragraph}>{m.notifications_mail_reset_body({}, { locale })}</Text>
    </Layout>,
  );

export const testMail = (locale: Locale) =>
  both(
    <Layout
      locale={locale}
      preview={m.notifications_mail_test_preview({ app: APP_NAME }, { locale })}
      heading={m.notifications_mail_test_heading({}, { locale })}
      footer={
        <Text style={muted}>{m.notifications_mail_test_footer({ app: APP_NAME }, { locale })}</Text>
      }
    >
      <Text style={paragraph}>{m.notifications_mail_test_body({ app: APP_NAME }, { locale })}</Text>
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
  locale: Locale;
}) =>
  both(
    <Layout
      locale={input.locale}
      preview={input.body}
      heading={input.title}
      action={
        input.openUrl
          ? {
              label: m.notifications_mail_open_chat({}, { locale: input.locale }),
              href: input.openUrl,
            }
          : undefined
      }
      footer={
        <Text style={muted}>
          {m.notifications_mail_why({}, { locale: input.locale })}
          {input.manageUrl ? (
            <>
              {" "}
              <Link href={input.manageUrl} style={footerLink}>
                {m.notifications_mail_edit_schedule({}, { locale: input.locale })}
              </Link>
            </>
          ) : null}
          {input.settingsUrl ? (
            <>
              {" · "}
              <Link href={input.settingsUrl} style={footerLink}>
                {m.notifications_mail_settings({}, { locale: input.locale })}
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
              {input.openUrl
                ? m.notifications_mail_continue_reading({}, { locale: input.locale })
                : m.notifications_mail_rest_in_chat({}, { locale: input.locale })}
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={paragraph}>{input.body}</Text>
      )}
    </Layout>,
  );

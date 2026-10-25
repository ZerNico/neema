import {
  Body,
  Button,
  Container,
  Font,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "react-email";
import type { ReactNode } from "react";
import { LOGO_CID } from "./logo.ts";
import { APP_NAME, COLORS, FONT_STACK, muted } from "./styles.ts";
import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";

/** The link spelled out under a button, for clients that block buttons. */
function Fallback({ href, locale }: { href: string; locale: Locale }) {
  return (
    <Text data-text="skip" style={{ ...muted, margin: "20px 0 0", wordBreak: "break-all" }}>
      {m.notifications_mail_fallback_link({}, { locale })}{" "}
      <Link href={href} style={{ color: COLORS.muted, textDecoration: "underline" }}>
        {href}
      </Link>
    </Text>
  );
}

/** The app's sign-in page as mail: the mark on the canvas, one sheet, a pill button. */
export function Layout({
  locale,
  preview,
  heading,
  action,
  footer,
  children,
}: {
  locale: Locale;
  preview: string;
  heading: string;
  action?: { label: string; href: string } | undefined;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Html lang={locale}>
      <Head>
        <Font
          fontFamily="Geist"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: "https://cdn.jsdelivr.net/fontsource/fonts/geist:vf@latest/latin-wght-normal.woff2",
            format: "woff2",
          }}
          fontWeight="100 900"
          fontStyle="normal"
        />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: "0",
          padding: "40px 12px",
          backgroundColor: COLORS.canvas,
          fontFamily: FONT_STACK,
        }}
      >
        <Container style={{ maxWidth: "560px" }}>
          <Text
            style={{
              margin: "0 0 20px",
              textAlign: "center",
              fontSize: "16px",
              lineHeight: "28px",
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: COLORS.foreground,
            }}
          >
            <Img
              src={`cid:${LOGO_CID}`}
              width="28"
              height="28"
              alt=""
              style={{
                display: "inline-block",
                verticalAlign: "middle",
                marginRight: "10px",
                borderRadius: "7px",
              }}
            />
            <span style={{ verticalAlign: "middle" }}>{APP_NAME}</span>
          </Text>
          <Section
            style={{
              padding: "36px 40px",
              borderRadius: "32px",
              border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.sheet,
            }}
          >
            <Heading
              as="h1"
              style={{
                margin: "0 0 16px",
                fontSize: "24px",
                lineHeight: "32px",
                fontWeight: 600,
                letterSpacing: "-0.015em",
                color: COLORS.foreground,
              }}
            >
              {heading}
            </Heading>
            {children}
            {action ? (
              <>
                <Button
                  href={action.href}
                  style={{
                    margin: "8px 0 0",
                    padding: "11px 22px",
                    borderRadius: "999px",
                    backgroundColor: COLORS.primary,
                    color: COLORS.primaryForeground,
                    fontSize: "14px",
                    lineHeight: "18px",
                    fontWeight: 500,
                  }}
                >
                  {action.label}
                </Button>
                <Fallback href={action.href} locale={locale} />
              </>
            ) : null}
          </Section>
          <Section style={{ padding: "20px 40px 0" }}>{footer}</Section>
        </Container>
      </Body>
    </Html>
  );
}

# Changelog

Notable changes per release, newest first. A release takes its notes from the
section headed with its version, such as `## [1.2.3] - 2026-10-07`; write it
before pushing the tag.

## [0.1.0] - 2026-10-07

The first release: a self-hosted chat app for talking to LLMs, as a Docker image
(`ghcr.io/zernico/neema:0.1.0`) and an unsigned desktop app for macOS, Windows and Linux.

- Chats with resumable streaming, retry, edit, branching, queued messages and steering,
  temporary and archived chats, and search across everything.
- Providers: any OpenAI-compatible service, Azure and Amazon Bedrock, with one
  admin-defined model order and a cheap model for titles.
- Web search over a provider chain, page and PDF reading, and deep research runs with
  footnote citations.
- Knowledge collections, saved agents, skills and memory.
- Projects with shared instructions, live co-edited documents, files and memory.
- Word, Excel and PowerPoint working files with previews.
- Scheduled prompts, admin-authored custom tools, and integrations with Outline,
  Outlook and Jira, each connected per person.
- Desktop Work: local files and an embedded browser the model can use with your approval.
- Sign-in with email, OAuth or OpenID Connect, with open, approval or closed signup.

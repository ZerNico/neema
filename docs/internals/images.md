# Images

Answers draw through one tool, `generate_image`, which the chat model calls and an image model
the person chose carries out. Any chat model can draw, through the Hermes polyfill too. A chat
model that outputs images itself (`capabilities.imageOutput`, see [providers](providers.md))
still does, beside the tool.

## Image models

- An image model is a `models` row with `type = 'image'`, on the same providers as chat models,
  with their keys, group access, descriptions and admin order. Its own order: saving the chat
  order never touches it, and the other way round (`setDefaultModelOrder` by type).
- `image_family` says how it is called and what it can do at most. It is apart from the model key
  because an Azure deployment name says nothing about the model behind it. Families live in
  `@chat/model-client` (`images/families.ts`), and a preset lists the families it hosts. A row
  whose family its preset no longer hosts is never offered.
- `image_capabilities` is what an admin allows, always clipped to the family's limits where it is
  read (`effectiveImageCapabilities`), so it can narrow a family and never widen it.
- `image_pricing` is its own column, so no token-pricing reader ever sees an image row. Every
  family takes any mix of token prices, prices per image by quality, and a fee per reference
  image. Cost per call is the provider's own figure, else token prices when the API reported
  usage, else the quality's price per image, else the `default` one marked `estimate`. A quality
  the provider picked itself (none was sent, on a family that has them) is an estimate too. The
  reference fee is added to either, once per call, since a batch made one image per call sends
  the references with each. A fee alone is not a cost, so the cost stays unknown.
- OpenRouter's prices fill the form when a model is picked. They are per token, from its
  listing asked for image output, since its image listing has none. Its `image` field means
  two things: a fee per reference where `image_token` is listed too, else (Gemini) the price per
  token of reading an image.

## Which model draws

- Each attempt resolves one image model in its transaction: what this submission picked (send,
  edit, retry, queue entry, a schedule's fire), else the chat's lock, else the agent's
  preference, else the first in the admin's order the person may use. The result becomes the lock
  (`conversations.image_model_id`) in the same transaction, so a deleted, disabled or forbidden
  model falls back once and the chat stays on its replacement.
- An agent or schedule drafted in chat sets its image model like its chat model, from the
  `availableImageModels` the draft data lists. Null leaves the choice to each chat.
- A structured answer, a ui-block suggestion and a steer pick nothing and follow the lock.
  Research workers are never offered the tool. A branch copies the lock.
- The streaming engine loads the attempt's model once, before the toolkit, and holds it for every
  round. Resume keeps the model the answer's earlier rounds drew with while it is usable, else
  offers no tool, and never moves the lock: switching models mid-answer is never right.
- `message_generation_config` keeps the latest attempt's model and name. The ledger keeps each call.

## The prompt

- The tool's schema never changes with the model: every option any family takes is offered, and
  the handler fits a request to the model (`normalizeImageRequest`), reporting each change as an
  adjustment the model and the person see. A call that names no quality leaves it to the
  provider only while every quality the family has is allowed. Once an admin narrows them, the
  cheapest allowed one is sent, since the provider's own pick may be one taken away.
- A fixed system line says what the tool is for. Which model it draws with, and what that model
  can do, goes in a trailing `<application-policy>` after history, fixed for the answer, so
  changing models never uncaches the prefix ([prompt caching](prompt-caching.md)).

## A call

- References are files the sender may read in this chat or its project, by id, `attachment:` or
  `project:` reference, name, or the app's own `/api/files/<id>` link, which the shared resolver
  reads as the attachment it names. Search images are never references. PNG, JPEG and WebP only,
  as the family takes them. The server never decodes an image.
- The handler returns a result without bytes and stages the images by provider call id. The
  stream consumer stores them on the terminal result, through `deliverFile` under the generation
  fence, as answer files with `source: "image-tool"` and the call's row as origin. Vision models
  then see them once, like any file.
- Generated images (the tool's and a model's own) have their own bound per answer, 16, beside the
  five for other tool files, and one 64 MB ceiling covers both. Calls run in parallel ahead of the
  consumer, so each reserves its slots before it spends and hands back what it did not use. A
  model's own image holds a slot once stored, so a later call draws only what fits. A call in the
  same round can run ahead of images the model is streaming, so both are kept, in either order,
  since both were paid for. The tool's images were counted when their slots were granted
  (`reserved`), and a model's own image is counted only against the model's own. The count can
  overshoot by what was in flight, at most twice the bound, and the byte ceilings, checked again
  in delivery's transaction, are what bound it. A delivery they refuse is that call's error,
  never the answer's. When some of a call's images are kept and some refused, the call
  succeeds and says what it lost, first among its adjustments, so the model and the caption
  both show it. Resume counts what the answer already holds.
- Images only ever come back as base64. A returned URL is an error, never fetched.
- A refusal is the provider's words in the call's result, and the answer goes on. An answer that
  is only an image is not empty.

## The ledger

- One `usage_events` row per image operation, `kind = 'image'`, written once by a finalizer
  whatever happened: images the provider made (billed, not delivered), its usage and cost, and
  the call's row. The handler waits for that row before it asks the provider, since a finalizer
  must not wait on anything. It is independent of delivery and of the fence. Interrupted after the
  provider answered, it keeps what was known. Interrupted before, it is `aborted` with unknown
  usage, never zero.
- `usage_complete` means the whole cost is known: the provider reported usage or cost, or an
  exact price per image applies, which needs no usage (Bedrock reports none). A batch keeps what
  its requests reported and is never complete when one failed or left its own unreported.
- A reply that billed but sent an image the server refuses (not PNG, JPEG or WebP, too large,
  or none at all) is `unusable`, not an error, so the usage it reported reaches the row.
- Image calls are attempts of their own, so analytics counts them beside chat answers.

## Drafts while drawing

- GPT Image streams in-progress images when asked (`stream`, `partial_images`). The adapter asks
  only for a single image with a listener, so batches and other families answer whole. It stops
  reading at the finished image, and reads a gateway that ignores `stream` and answers JSON as
  if it had not asked. The admin's model test asks the same way, so it fails where chats would.
- Drafts are shown, never stored: the engine publishes each as a `preview` event keyed by the
  call's row, keeps only the newest per running call in memory, and replays that to a page that
  subscribes mid-draw (a reload, a second tab). The call's result clears it. Nothing reaches
  `message_chunks`, so a page opened after the call never sees one.
- The server never decodes a draft, any more than a finished image: it is sniffed and passed on.

## Display

- A call is one part of the answer, drawn where it was made: a frame in the aspect ratio the
  call's activity records, the newest draft in it
  when there is one, then its images in their place, claimed by origin from the answer's files.
  Live stream, reload and branch project the same rows. A branch maps the call's attachment ids
  to its copies and points each file's origin at the copied row.
- A call's row holds a `running` snapshot from insertion (model, shape, count), so a page that
  loads mid-draw names the model and draws the frame the live start named.
- Edit puts an image tag into the composer, a link to the file the model can pass back. The
  person picks the image model in the composer, and a pick goes with the next send or retry.
  The picker shows what the server will draw with, in its order: the pick, the chat's lock, the
  agent's preference, then the admin's first, each only while usable.

## Adapters

- `generateImages` dispatches by family: the OpenAI Images API (OpenAI, Azure, Vercel and any
  compatible server), xAI's, OpenRouter's Images API, Gemini's `generateContent`, and Bedrock's
  `InvokeModel` per model family. Interruption aborts the request, and nothing is retried.
- Families that draw one image per request run a batch as parallel calls, each under its own
  timeout. A failed or hung call loses only its own image, since the others were drawn and
  billed. The batch fails when all did. Otherwise it says why it came back short (`shortfall`,
  first among the call's adjustments) and its totals are marked `incomplete`.
- Previews are image-sized lines of server-sent events, arriving over hundreds of chunks. The
  shared parser scans only each new chunk's bytes and reads a line once it ends, so its cost
  stays linear.
- OpenRouter hosts chat models too, so a typed key becomes an image model only when it reads as
  one (`inferImageFamily`). Its catalog lists a model that both chats and draws twice, once per
  type: as a chat model it draws in its own answer, as an image model any chat can call it.
- Imagen is gone from the Gemini API, so no preset hosts that family.

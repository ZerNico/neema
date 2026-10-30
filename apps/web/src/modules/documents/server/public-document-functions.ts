import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { runServerFn } from "~/server/run-server-fn.ts";
import { PublicDocumentInput } from "../schema.ts";
import { DocumentService } from "./document-service.ts";

/** A document through its public link, to anyone holding it, signed in or not. */
export const getPublicDocument = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(PublicDocumentInput))
  .handler(({ data }) =>
    runServerFn(Effect.flatMap(DocumentService, (service) => service.readPublic(data.token))),
  );

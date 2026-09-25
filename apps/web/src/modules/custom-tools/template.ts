/** What a new module starts from; `builder.test.ts` compiles it as written. */
export const TEMPLATE_SOURCE = `import { Schema, defineModule, defineTool, file, fileInput } from "@chat/custom-tools";

export default defineModule({
  echo: defineTool({
    name: "Echo text",
    description: "Echo the supplied text back to the model.",
    parameters: Schema.Struct({
      text: Schema.String.annotate({ description: "Text to echo" }),
    }),
    run: async ({ text }) => \`You said: \${text}\`,
  }),

  // A file parameter: the assistant passes a file from the chat or its
  // project, and run receives its bytes. Files returned become attachments.
  shout_file: defineTool({
    name: "Shout a text file",
    description: "Return an upper-cased copy of a text file.",
    parameters: Schema.Struct({
      source: fileInput({ description: "The text file to copy", accept: [".txt", ".md"] }),
    }),
    run: async ({ source }) => ({
      text: \`Upper-cased \${source.name} (\${source.size} bytes).\`,
      files: [file(source.text().toUpperCase(), { name: \`loud-\${source.name}\` })],
    }),
  }),
});
`;

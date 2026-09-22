/** What a new module starts from; `builder.test.ts` compiles it as written. */
export const TEMPLATE_SOURCE = `import { Schema, defineModule, defineTool } from "@chat/custom-tools";

export default defineModule({
  echo: defineTool({
    name: "Echo text",
    description: "Echo the supplied text back to the model.",
    parameters: Schema.Struct({
      text: Schema.String.annotate({ description: "Text to echo" }),
    }),
    run: async ({ text }) => \`You said: \${text}\`,
  }),
});
`;

// What an admin allows for image generation: one row in the tools registry,
// read once per attempt like the interactive answers switch. Without an image
// model nothing is offered anyway.

export const IMAGE_GENERATION_TOOL = "image_generation";

type ToolRow = { readonly enabled: boolean };

export const imageGenerationEnabled = (tool: ToolRow): boolean => tool.enabled;

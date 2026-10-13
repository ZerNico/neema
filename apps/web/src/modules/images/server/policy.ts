/**
 * Stable text for every attempt offered `generate_image`. Which model it draws
 * with goes in the trailing note, so changing models never touches this.
 */
export const IMAGE_APP_POLICY =
  "generate_image creates or edits images with the image model the person chose. Use it when they ask for a picture, an illustration, a logo, a mockup or a change to an image; do not draw unprompted. To change an image, pass it in references: images in this chat, generated or attached, are files you can name by id. The images it makes appear in your answer by themselves, so never link or embed them; add at most a short line about what you made. When it refuses or fails, say so plainly and do not describe an image you did not make.";
